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
 *    - `memory.search`     → `AuditLogStore.listByRecipe / listRecent`
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
  executionSourceContractId,
  // D-237 P1 — the per-instance freshness verdict the AI-facing collection
  // reads now carry, alongside the CRM trio's `crm_freshness`.
  collectionSourceFreshnessFanOut,
  type CollectionHealth,
  type CollectionSourceFreshnessEntry,
  type ExecutionSource,
  type ChatConfidenceEnvelope,
  type ChatContactCandidate,
  type ChatDealCandidate,
  type ChatAccountCandidate,
  type CrmConnectionFreshness,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type ConnectionMcpAnnotationState,
  type ContactAliasPlatform,
  type CrmAlias,
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
import type { Tier2RecipeEntry, IngredientKindLookup } from '@recued/recipes';
import type {
  AuditEntry,
  AuditLogStore,
  Collection as StorageCollection,
} from '@recued/storage';
import type { ContactStore } from './storage/contact-store.js';
import type { EnrichmentStore } from './storage/enrichment-store.js';
import type { CrmRecordMirrorStore } from './storage/crm-record-mirror-store.js';
import type { CollectionRegistry } from './collections/registry.js';
import { DATA_FILE_RECEIVED_SLUG } from './collections/file/file-read-handler.js';
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

import type { ServerExecutorConfig } from './server-executor.js';
import { executeResponseAuditRunId } from './types.js';
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
import { createStoreBackedMemoryWriteAdapter } from './memory-write-adapter.js';
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
import type { WorkEntityTargetedReadDeps } from './work-entity-write-executor.js';
// D-225 § 9.5.1 — the raw catalog-op projection, shared with the inbound door.
import {
  OP_TOOL_PREFIX,
  buildRawOpToolDescriptors,
  buildRecipeOpCoverage,
  rawOpToolEntriesFrom,
  visibleRawOps,
  type RawOpToolEntry,
} from './raw-op-tool-catalog.js';
import {
  dispatchRawOp,
  type RawOpDispatchDeps,
  type RawOpDispatchOutcome,
} from './raw-op-dispatch.js';
import { buildPackOpResolution, type InstalledPackScan } from './pack-inventory.js';

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
  /** D-237 P1 — injectable clock for the source-freshness verdicts the
   *  collection reads now carry. Absent ⇒ `Date.now`, matching every D-236 call
   *  site. Present so a test can pin an age rather than infer one from wall
   *  clock, which is how a staleness assertion becomes a flake. */
  now?: () => number;
  getContactStore: () => ContactStore | undefined;
  getCollectionRegistry: () => CollectionRegistry | undefined;
  /** D-172 P2 — the session's own message rows, for `file.search`'s default
   *  (and safe) scope. Optional because a dbless / partial harness has no chat
   *  store; absent ⇒ session scope returns EMPTY with a stated reason rather
   *  than silently falling through to the whole file store. */
  getChatStore?: () => {
    listMessages(session_id: string): Promise<ReadonlyArray<{
      attachments?: ReadonlyArray<{ file_id: string }>;
    }>>;
  } | undefined;
  getAuditLog: () => AuditLogStore | undefined;
  /** D-198 Slice 4 — the owner-authored + AI/customer-written `user_memory`
   *  store. `memory.write` writes here (stamped `contracted_user`) and the
   *  widened `memory.search` unions it with the audit log. Absent (db-less
   *  harness / pre-wire) → `memory.write` reports `execution_error` and
   *  `memory.search` falls back to the audit-only read. */
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
}

/** Hard ceilings to bound the per-call payload landing in the chat
 *  agent's main-turn prompt + the `chat.tool_call_completed` broadcast.
 *  Each list / search defaults to `DEFAULT_LIMIT` when args omit one;
 *  user-supplied values clamp to `MAX_LIMIT`. */
const DEFAULT_LIMIT = 20;
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
  const runAddress = run_id !== undefined ? { run_id } : {};
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
const isCollectionReadGrantedForDispatch = (
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
const markEntity = <T extends ChatContactCandidate | ChatDealCandidate | ChatAccountCandidate>(
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
      return { ok: true, result: { ...augmented, crm_freshness: escalated.crm_freshness } };
    } catch (e) {
      return executionError(errMessage(e));
    }
  };

// ────────────────────────────────────────────────────────────────
// mail.search — generic Collection fan-out
// ────────────────────────────────────────────────────────────────

/** D-205 #3 — the GUIDED-EMPTY a fenced read returns on the `{ matches, collections }`
 *  envelope (`mail.search` / `calendar.search`). `ok: true` + a `hint`: never `ok:false`
 *  (the Tier-1 ANTI-LOOP invariant) and never a BARE empty — `{ matches: [] }` is
 *  indistinguishable from an empty mailbox, so without the hint the model reports the
 *  fence to the user as *"you have no mail from Bob"*. */
const collectionReadFenced = (collection: ReadableCollection) => ({
  ok: true as const,
  result: {
    matches: [] as Array<Record<string, unknown>>,
    collections: [] as string[],
    hint: collectionReadFencedHint(collection),
  },
});

const createMailSearchHandler =
  (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw, ctx) => {
    // D-205 #3 — the `data.mail` read fence, BEFORE the registry is touched. Same hole
    // `contact.search` had, and `mail` is the more sensitive collection.
    if (!isCollectionReadGrantedForDispatch(deps, ctx, 'mail')) {
      return collectionReadFenced('mail');
    }
    const registry = deps.getCollectionRegistry();
    if (!registry) return executionError('collection registry unavailable');
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
    const collections = registry.list().filter((c) => c.platform === 'mail');
    if (collections.length === 0) {
      // D-237 P1 — no mailbox is enrolled. `collections: []` is the fact, and
      // `source_freshness: []` must not be read as "the sources are fine": the
      // two empties answer different questions and the descriptor says so.
      return { ok: true, result: { matches: [], collections: [], source_freshness: [] } };
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
      for (const c of collections) {
        if (query) {
          const matches = c.search({
            platform: c.platform,
            slug: c.slug,
            query,
            limit: perCollectionLimit,
          });
          for (const m of matches) {
            aggregated.push({
              collection_slug: c.slug,
              record_id: m.record_id,
              hot_fields: m.hot_fields,
              rank: m.rank,
              snippet: m.snippet,
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
          for (const r of rows) {
            aggregated.push({
              collection_slug: c.slug,
              record_id: r.record_id,
              hot_fields: r.hot_fields,
              received_at: r.received_at,
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
      // D-237 P1 — the verdict rides out with the records it qualifies, exactly
      // as D-236 made it ride `collection.list`. An empty `matches` here is an
      // ABSENCE, and an absence is only a fact once you know the source was
      // current when it was read.
      return {
        ok: true,
        result: {
          matches: truncated,
          collections: collections.map((c) => c.slug),
          source_freshness: collectionSourceFreshnessFanOut(
            collections,
            (deps.now ?? Date.now)(),
          ),
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
    if (!isCollectionReadGrantedForDispatch(deps, ctx, 'calendar')) {
      return collectionReadFenced('calendar');
    }
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
      for (const c of collections) {
        if (query) {
          const matches = c.table.search({
            query,
            limit: perCollectionLimit,
          });
          for (const m of matches) {
            aggregated.push({
              collection_slug: c.slug,
              record_id: m.record_id,
              hot_fields: m.hot,
              rank: m.rank,
              snippet: m.snippet,
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
            aggregated.push({
              collection_slug: c.slug,
              // Exact Data/collection.get address. `source_id` is provider
              // native and cannot round-trip through the generic explorer.
              record_id: r.record_id,
              hot_fields: r.hot,
              received_at: r.received_at,
            });
          }
        }
      }
      const truncated = aggregated.slice(0, limit);
      // D-237 P1 — calendar reads its own `CalendarCollectionTable` rather than
      // the `collection.list` path, exactly as `calendar-dispatcher.ts` does, so
      // the verdict is DERIVED here from the same `health()` rather than
      // approximated or omitted.
      return {
        ok: true,
        result: {
          matches: truncated,
          collections: collections.map((c) => c.slug),
          source_freshness: collectionSourceFreshnessFanOut(
            collections,
            (deps.now ?? Date.now)(),
          ),
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
const MEMORY_READ_OP_ID = 'core.memory.read';

/** D-198 §3 — admit the `user_memory` union portion of a memory.search. The
 *  audit portion stays owner-trusted (unchanged); the pool's durable memories
 *  are shared by the `core.memory.read` grant — permissive for the owner,
 *  fail-closed for a door until the seller grants the tier. Absent gate / absent
 *  source ⇒ excluded (fail closed; the audit rows still flow, so no regression).
 *  Per-topic `scope_restrictions` (build-plan §D) ride the grant itself; v1
 *  gates the whole pool read per §3's separate-server-per-product curation. */
const admitMemoryRead = (
  gate: Pick<OpAdmissionGate, 'isOpGranted'> | undefined,
  source: ExecutionSource | undefined,
): boolean =>
  gate !== undefined
  && source !== undefined
  && (source.actor === 'user_self' || source.actor === 'contracted_user')
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
}

const projectMemoryEntry = (
  r: UserMemoryRow,
  body: string | undefined,
  truncated: boolean,
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
  media_class: string;
  size_bytes: number;
  origin: string;
  scan_status: string;
  received_at: number;
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
    const fileSourceFreshness = (): CollectionSourceFreshnessEntry[] =>
      collectionSourceFreshnessFanOut(
        [{ slug: DATA_FILE_RECEIVED_SLUG, health: collection.health }],
        (deps.now ?? Date.now)(),
      );

    const rawScope = typeof args.scope === 'string' ? args.scope : 'session';
    // An unrecognized scope falls back to the NARROW one. A typo must never be
    // the thing that widens a search whose whole point is being narrow.
    const scope: 'session' | 'all' = rawScope === 'all' ? 'all' : 'session';
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
    const limit = Math.min(
      typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
        ? Math.floor(args.limit)
        : FILE_SEARCH_DEFAULT_LIMIT,
      FILE_SEARCH_MAX_LIMIT,
    );

    let rows: ChatFileRow[] = [];
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
      const listed = collection.list?.(FILE_SEARCH_MAX_LIMIT) ?? [];
      rows = (listed as Parameters<typeof projectChatFileRow>[0][]).map(projectChatFileRow);
    }

    if (query.length > 0) {
      rows = rows.filter((r) => r.filename.toLowerCase().includes(query));
    }
    rows.sort((a, b) => b.received_at - a.received_at);
    const truncated = rows.length > limit;
    rows = rows.slice(0, limit);

    // D-237 P1 — session scope reads the conversation's attachments THROUGH the
    // file collection (`collection.get`), and a referenced file whose record has
    // not landed yet is SKIPPED by design a few lines up. So a lagging file
    // source silently shortens this list, and the verdict qualifies both scopes.
    return {
      ok: true,
      result: {
        files: rows,
        scope,
        source_freshness: fileSourceFreshness(),
        ...(truncated ? { truncated: true } : {}),
        // The scope is stated back on EVERY result, not just when widened. A
        // model that forgot which set it searched will otherwise report an
        // absence it never actually established.
        hint: scope === 'session'
          ? 'These are the files of THIS conversation only. If Mary means a file from elsewhere, ask her before widening.'
          : 'This searched EVERY file Mary holds, including uploads from strangers via her public form. Check `origin` and `scan_status` before putting any of these into something that leaves her machine.',
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
      const redactionStore = deps.getMemoryRedactionStore?.();
      const redacted = redactionStore
        ? new Set((await redactionStore.list()).map((r) => r.memory_id))
        : new Set<string>();

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
        const body = overCap ? full!.slice(0, MEMORY_FETCH_ONE_CAP_BYTES) : full;
        const entry = projectMemoryEntry(resolved.row, body, overCap);
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

      const filtered = ordered.filter(
        (r) =>
          !redacted.has(r.memory_id)
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
            memories.push(projectMemoryEntry(row, body, false));
            continue;
          }
        }
        // Didn't fit (or has no body / the blob vanished) → preview + the id.
        if (row.size_bytes > 0) truncatedCount += 1;
        memories.push(projectMemoryEntry(row, undefined, row.size_bytes > 0));
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
const MEMORY_WRITE_OP_ID = 'core.memory.write';

/** Gate a memory write on the governing contract's `core.memory.write` grant
 *  (mirrors `admitVendorWrite`): only `user_self` (owner chat — permissive by
 *  default) and `contracted_user` (a door the seller granted) may write; the
 *  gate fails closed when absent. The store always stamps `contracted_user` (§3
 *  origin-honesty — the AI writes under a contract; the owner's own direct
 *  webclient writes are the only `user_self` rows). */
const admitMemoryWrite = (
  gate: Pick<OpAdmissionGate, 'isOpGranted'> | undefined,
  source: ExecutionSource | undefined,
): boolean =>
  gate !== undefined
  && source !== undefined
  && (source.actor === 'user_self' || source.actor === 'contracted_user')
  && gate.isOpGranted(source, MEMORY_WRITE_OP_ID);

/** D-198 Slice 4 — the live `memory.write` path (Fork 2 = A). "Remember this" in
 *  owner chat + (when a seller grants a tier) autonomous customer contributions,
 *  both writing `contracted_user` rows into the ONE pool via the store-backed
 *  adapter. Grant-gated (`core.memory.write`) — the enforcement boundary, NOT
 *  plan-approval (the tool is `classification: 'unknown'` so it bypasses P3;
 *  §3 soft writes). Reversible via the Memory lens redact. */
const createMemoryWriteHandler =
  (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw, ctx) => {
    const store = deps.getUserMemoryStore?.();
    if (!store) return executionError('memory store unavailable');
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');

    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    if (summary.length === 0) {
      return invalidArgs('memory.write requires a non-empty summary');
    }

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

    const adapter = createStoreBackedMemoryWriteAdapter({
      store,
      origin_actor: 'contracted_user',
      ...(hasSession ? { session } : {}),
    });

    try {
      const body =
        typeof args.body === 'string' && args.body.length > 0 ? args.body : undefined;
      const provenance = Array.isArray(args.provenance_entity_ids)
        ? args.provenance_entity_ids.filter(
            (x): x is string => typeof x === 'string' && x.length > 0,
          )
        : [];
      const result = await adapter.write({
        kind: 'chat_memory',
        summary,
        reason_code: 'chat_write',
        ...(body !== undefined ? { payload: body } : {}),
        ...(provenance.length > 0 ? { provenance_entity_ids: provenance } : {}),
      });
      // Fan a `memory` refresh so paired Memory lenses live-update (§7.7).
      emitMemoryUser(deps.getEventBus?.(), result.memory_id);
      return { ok: true, result };
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
    return admitSourceCatalogEscalation(deps.getOpAdmissionGate?.(), ctx, {
      catalogSlug: binding.catalogSlug,
      manifest: binding.manifest,
      operation: `${f.entity}.search`,
    }).admitted;
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
  const config =
    recipeIdOverride !== undefined
      ? args
      : args.config && typeof args.config === 'object' && !Array.isArray(args.config)
        ? (args.config as Record<string, unknown>)
        : undefined;
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
    trigger_source: channelTriggerSource(ctx),
    ...(ctx.execution_source ? { execution_source: ctx.execution_source } : {}),
    ...(ctx.contract_snapshot ? { contract_snapshot: ctx.contract_snapshot } : {}),
    // The I-7 hop token rides beside the source (D-160 P3): a messenger
    // turn's recipe dispatch runs at the turn's ingest depth, so the
    // Gateway's loop ceiling sees re-entrant fires truthfully.
    ...(ctx.dispatch_depth !== undefined ? { dispatch_depth: ctx.dispatch_depth } : {}),
  };
};

/** Codex review P2 fold (2026-05-12) — resolve publisher-qualified
 *  recipe ids. The `recipe.run` descriptor (§ A.13) tells the model to
 *  invoke recipes by `<publisher>/<slug>`, but `RecipeStore.get()` is
 *  keyed by the bare recipe_id (publisher lives in a separate
 *  `StoredRecipe.publisher_id` column). The lookup tries the literal
 *  string first (works when a recipe_id happens to contain `/`); on
 *  miss + presence of a `/`, retries with the substring after the
 *  first slash. Returns the resolved id or the original on miss
 *  (handleExecute then surfaces `recipe_not_found` verbatim). */
const resolveRecipeId = (
  raw: string,
  recipeStore: RecipeStore,
): string => {
  if (recipeStore.get(raw)) return raw;
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return raw;
  const stripped = raw.slice(slash + 1);
  return recipeStore.get(stripped) ? stripped : raw;
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
      return executionError(errMessage(e));
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
    );
    if (typeof req === 'string') return invalidArgs(req);
    try {
      const result = await execute(req);
      return wrapRecipeRunResult(result);
    } catch (e) {
      return executionError(errMessage(e));
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
const WORK_ENTITY_READ_OP_ID = 'core.work-entity.read';

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
  gate: Pick<OpAdmissionGate, 'isOpGranted'> | undefined,
  source: ExecutionSource | undefined,
): boolean =>
  gate !== undefined
  && source !== undefined
  && (source.actor === 'user_self' || source.actor === 'contracted_user')
  && gate.isOpGranted(source, WORK_ENTITY_READ_OP_ID);

const workEntityReadToolsDeps = (deps: ChatToolHandlerDeps): WorkEntityReadToolsDeps => ({
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
  'matches', 'candidates', 'entries', 'memories', 'enrichments', 'rows', 'items',
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

export const buildChatTier1Handlers = (
  deps: ChatToolHandlerDeps,
): Record<string, Tier1Handler> => wrapEmptyResults({
  'contact.search': createContactSearchHandler(deps),
  'mail.search': createMailSearchHandler(deps),
  'calendar.search': createCalendarSearchHandler(deps),
  'memory.search': createMemorySearchHandler(deps),
  'memory.write': createMemoryWriteHandler(deps),
  'enrichment.search': createEnrichmentSearchHandler(deps),
  'deal.search': createDealSearchHandler(deps),
  'account.search': createAccountSearchHandler(deps),
  'work.search': createWorkSearchHandler(deps),
  'work.read': createWorkReadHandler(deps),
  'file.search': createFileSearchHandler(deps),
  'recipe.run': createRecipeRunHandler(deps),
});

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

export const createChatRawOpSource = (
  deps: ChatToolHandlerDeps,
): ((source?: ExecutionSource) => RawOpToolEntry[]) => (source) => {
  const scan = deps.scanInstalledPacks;
  if (!scan) return [];
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
  if (!gate) return rawOpToolEntriesFrom(universe);
  // ⛔ An ABSENT source DENIES. `TurnContext.source` is optional ("only for bare
  // test harnesses"), so a missing one is reachable — and `isOpGranted` returns
  // TRUE when no contract governs, so passing a synthesised or undefined source
  // would make the filter admit everything while looking identical to a working
  // one. Fail closed instead: no source, no derived catalog.
  if (!source) return [];
  return rawOpToolEntriesFrom(visibleRawOps(universe, (opId) => gate.isOpGranted(source, opId)));
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
export const createChatRawOpDispatch = (
  deps: ChatToolHandlerDeps,
): ChatRawOpDispatch => async (toolName, args, ctx) => {
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
  rawOpDispatch: createChatRawOpDispatch(deps),
});

/** Re-export for callers that want to construct the ctx for
 *  out-of-orchestrator dispatches (tests, future MCP wire wrapping).
 *  No new contract — this just narrows the import surface. */
export type { ChatDispatchContext, ChatDispatchResult };
