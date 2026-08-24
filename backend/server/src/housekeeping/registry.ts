/** D-123 Phase 1 — Per-process housekeeping task registry.
 *
 *  Singleton Map populated by `bin.ts` at boot before the scheduler
 *  constructs. Tests use `createHousekeepingRegistry()` to get a
 *  fresh isolated registry; production uses the default singleton.
 *  Topo-sort honours `meta.depends_on`; cycles throw at sort time
 *  (programming error, not runtime condition).
 *
 *  Spec: D-123 §1.3. */

import type Database from 'better-sqlite3';

import type {
  ConnectionVendorEntity,
  EngagementsResolverArgs,
  EngagementsResolverResult,
  EnrichmentScope,
  EnrichmentTopic,
  HousekeepingCursor,
  HousekeepingStepResult,
  HousekeepingTaskMeta,
  IngredientManifest,
  PiiFieldTag,
  TrackedCommitment,
} from '@recued/contracts';
import type {
  ForceLayer,
  TranscriptionRequest,
  TranscriptionResult,
} from '@recued/llm';

import type { EnrichmentStore } from '../storage/enrichment-store.js';
import type { CrmRecordMirrorStore } from '../storage/crm-record-mirror-store.js';
import type { RecipeStore } from '../recipe-store.js';
import type { BlobStore } from '../storage/blob-store.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import type { UserMemoryStore } from '../user-memory-store.js';
import type { WarehouseEventBus } from '@recued/warehouse-events';

import type { TrustStore } from './trust-store.js';
import type { TunableParamsAccessor } from './tunable-params-accessor.js';
import type { LlmResultCacheStore } from './llm-result-cache-store.js';
import type { VendorRateGate } from './reconciliation/vendor-rate-gate.js';
import type { EventBus } from '../events/bus.js';

// ────────────────────────────────────────────────────────────────
// Context handed to every task on each step.
// ────────────────────────────────────────────────────────────────

export interface HousekeepingAuditRow {
  ts: number;
  event_at: number;
  action: string;
  target: string;
  run_mode: 'live' | 'backfill' | 'manual';
  detail: Record<string, unknown>;
}

/** Thin callable wrapping the user's LLM executor with the closure
 *  of `LLMConfig + adapters + quota` already applied. AI-driven
 *  enrichment producers use this; deterministic producers leave it
 *  untouched. Throws `LLMError('AI_LLM_UNAVAILABLE')` when no slot,
 *  free-pool, or web-chat path resolves at call time — the cycle's
 *  per-task error counter handles propagation and the pre-confirm
 *  probe in `getEnrichmentInfo` keeps the Run-Now dialog from
 *  offering the call when no path exists. Server-side runtimes
 *  have no web-chat path (`webChatSupported: false`) by design. */
export type HousekeepingLlmExecute = (
  manifest: IngredientManifest,
  input: Record<string, unknown>,
) => Promise<unknown>;

/** D-136 §A.3 / audit §20.2 — sibling to `HousekeepingLlmExecute` that
 *  returns the resolved provider model id alongside the call result so
 *  the producer wrapper can stamp `model_id` onto the enrichment row.
 *  Cross-pool PSI invalidation (Groq free pool ↔ Anthropic BYOK)
 *  requires the resolved model id, NOT the ingredient slug — the
 *  legacy `model_used` column was mis-populated as `'ai-classify'`
 *  and is renamed to `ingredient_slug` in P2; the new `model_id`
 *  column persists what this callable returns.
 *
 *  Composition is read off the executor's `onMatchResolved` callback
 *  in `bin.ts` — `winner.slot.provider + ':' + winner.slot.model`
 *  produces a self-describing string like `'openai:gpt-4o-mini'` or
 *  `'anthropic:claude-haiku-4-5'`. Web-chat sources resolve to
 *  `'web_chat:<tab>'`. Empty string when no match resolved (the call
 *  threw before completion).
 *
 *  Optional on `HousekeepingContext` for the same reason as `llm` —
 *  deterministic producers + their tests leave it unwired. P3
 *  retrofit calls it from `runAIProducer` so producers don't need to
 *  thread metadata themselves. */
export type HousekeepingLlmExecuteWithMeta = (
  manifest: IngredientManifest,
  input: Record<string, unknown>,
) => Promise<{ result: unknown; model_id: string }>;

/** D-136 P3 — pre-call probe for the resolved provider model id.
 *  Producer wrappers (`runAIProducer`) call this BEFORE the dedup
 *  probe so the dedup key includes the would-be model identity —
 *  cross-pool changes (free-pool ↔ BYOK) invalidate cached rows
 *  authored by a different model.
 *
 *  Returns `'<provider>:<model>'` (`'openai:gpt-4o-mini'`) when a
 *  match resolves; empty string when no match path resolves
 *  (probe is best-effort — the actual `executeLLM` call throws
 *  `AI_LLM_UNAVAILABLE` in that case). No round-robin advancement,
 *  no rate-limit accounting, no reject-set side effects. */
export type HousekeepingResolveModelId = (
  manifest: IngredientManifest,
  input: Record<string, unknown>,
) => Promise<string>;

/** D-131 A.3 — embeddings sibling to `HousekeepingLlmExecute`. Wraps
 *  `executeEmbedding` with the same shared `LLMConfig` + adapters +
 *  quota the chat path uses (cooldowns cross-pollinate per the D-131
 *  share-quota decision). Producers needing a vector — initially the
 *  `embedding` mail producer (A.3) — call this instead of `llm`.
 *
 *  Output shape mirrors the `ai-embed` ingredient's contract:
 *  `{ vector: number[], dimensions: number, model: string }`. The
 *  producer is responsible for serialising `vector` into the
 *  `sidecar_vector` Buffer the enrichment store consumes; the value
 *  payload itself records dimensions / model / byte length so recipes
 *  can read metadata without fetching the sidecar.
 *
 *  Throws `LLMError('AI_LLM_UNAVAILABLE')` when no embeddings path
 *  resolves — the pure-Anthropic case lands here. The Run-Now
 *  dialog's pre-confirm probe (`probeEmbeddingsPathAvailability`) is
 *  the primary UX gate; this throw is the race-window safety net. */
export type HousekeepingEmbedExecute = (
  manifest: IngredientManifest,
  input: Record<string, unknown>,
) => Promise<{
  vector: number[];
  dimensions: number;
  model: string;
}>;

export interface HousekeepingTranscribeOptions {
  /** D-172 P6 — per-topic pool-policy layer resolved by the enrichment
   *  harness. Mirrors the chat/embedding `llm.force_layer` precedence
   *  without adding a fake text input packet to raw audio transcription. */
  force_layer?: ForceLayer;
}

/** D-172 P6 — audio transcription callable for file-enrichment producers.
 *  Transcription is a distinct capability from multimodal chat; callers pass
 *  raw audio bytes and receive provider transcript metadata. It intentionally
 *  does not participate in the D-167 text PII-egress alias wrapper because
 *  binary audio cannot be text-aliased before egress. */
export type HousekeepingTranscribe = (
  request: TranscriptionRequest,
  options?: HousekeepingTranscribeOptions,
) => Promise<TranscriptionResult>;

/** D-167 — non-chat AI-egress PII aliasing tag source. Resolves which
 *  fields of a producer's source-record carry a `MetaField.privacy` tag
 *  (as dot-paths + kind, the shared `PiiFieldTag` shape) for a given
 *  enrichment `source_scope`. The per-record harness uses the resolved
 *  tags to seed a run-local alias ledger from the record's structured
 *  PII values, then content-scan + alias the LLM-bound packet before
 *  egress and restore the model output (see `enrichment-pii-egress.ts`).
 *
 *  INJECTED — optional, defaults to absent (the harness then skips the
 *  alias wrap entirely, byte-identical to pre-D-167 behaviour). The
 *  composition wiring supplies a resolver built from the installed
 *  entity schemas (the activation slice); harness tests inject a stub.
 *  Mirrors the chat `FieldPrivacyResolver` seam, but keyed on the source
 *  scope rather than walking the chat tool-result packet shape. */
export type EnrichmentPiiTagSource = (
  scope: EnrichmentScope,
) => readonly PiiFieldTag[];

export interface HousekeepingContext {
  /** D-250 § D — per-task provider-spend meter. Spread onto the ctx with the
   *  rest of the LLM callables bundle, because that is the one place the
   *  scheduler and the callables both reach. Optional: a db-less or AI-less
   *  boot has no callables, and a cycle simply records no tokens. */
  taskTokenMeter?: import('./task-token-meter.js').HousekeepingTaskTokenMeter;
  db: Database.Database;
  bus: WarehouseEventBus;
  enrichmentStore: EnrichmentStore;
  recipeStore: RecipeStore;
  now: () => number;
  emitAuditRow: (row: HousekeepingAuditRow) => void;
  /** D-184 — the shared per-(connection, vendor) rate gate. The vendor
   *  reconciliation harness (`buildVendorReconciliationTask`) acquires it per
   *  step: it caps the per-(connection, vendor) daily API budget across ALL
   *  reconcilers and skips a pull when one is already in flight for the same
   *  connection. Optional — absent ⇒ ungated (tests + non-vendor producers
   *  leave it unwired; production wires one shared instance via composition). */
  rateGate?: VendorRateGate;
  /** Round-12 audit fix (T1 § 8.1) — all-or-nothing per-topic queue-depth
   *  admission for a topic-wide recompute enqueue, bound to the SAME cascade
   *  budget governor the engine's own topic-wide sites consult
   *  (`CascadeEngine.reserveTopicRecomputeAdmission`). The D-136 P4 drift
   *  producer asks this BEFORE its signal+enqueue transaction, so a declined
   *  topic advances no severity and the next cycle re-fires under fresh
   *  headroom — the transaction's own atomicity invariant, kept. Optional —
   *  absent ⇒ ungated (tests + dbless harnesses), matching `rateGate`;
   *  production wires it from the composed cascade engine. */
  cascadeTopicAdmission?: (topic: string) => {
    admitted: boolean;
    candidates: number;
    dropped: number;
  };
  /** D-190 — the dedicated CRM record mirror. The vendor reconciliation
   *  harness (`buildVendorReconciliationTask`) upserts one row per CRM record
   *  UNCONDITIONALLY each cycle (independent of any AI producer + of the
   *  enrichment hash-diff), so `deal.search` / `contact.search` surface EVERY
   *  record, not just producer-enriched ones. Optional — absent ⇒ the harness
   *  skips the mirror write (dbless harnesses / non-CRM reconcilers / tests
   *  leave it unwired; production wires one shared instance via composition,
   *  beside the enrichment store). */
  crmRecordMirror?: CrmRecordMirrorStore;
  /** Live LLM executor for AI-driven enrichment producers
   *  (`estimate_per_record_tokens > 0`). See `HousekeepingLlmExecute`
   *  for the pre-confirm + race-window contract.
   *
   *  Optional so deterministic producers (`thread_signals`, the four
   *  core tasks) and their tests don't have to stub it. Production
   *  always wires it via `bin.ts`. AI producers throw at use-site
   *  when this is absent so misconfiguration surfaces cleanly. */
  llm?: HousekeepingLlmExecute;
  /** D-136 §A.3 — sibling to `llm` that surfaces the resolved provider
   *  model id alongside the call result. Producers retrofit to this at
   *  P3 via the `runAIProducer` wrapper so each enrichment row's
   *  `model_id` reflects the cross-pool decision (free vs BYOK), not
   *  the static ingredient slug. Optional — deterministic producers +
   *  tests leave it unwired; production wires it through `bin.ts`. */
  llmWithMeta?: HousekeepingLlmExecuteWithMeta;
  /** D-136 P3 — pre-call probe for the resolved provider model id.
   *  Producer wrappers fold the result into their dedup key so
   *  cross-pool changes invalidate cached rows authored by a different
   *  model. See `HousekeepingResolveModelId` for the contract. */
  resolveLLMModelId?: HousekeepingResolveModelId;
  /** D-131 A.3 — embeddings executor for producers whose output is a
   *  vector (today: `embedding`; future: `semantic_cluster`). Wired
   *  through `executeEmbedding` from `bin.ts`; `undefined` for tests
   *  + deterministic producers. AI-embed producers throw at use-site
   *  when this is absent so misconfiguration surfaces cleanly. */
  embed?: HousekeepingEmbedExecute;
  /** The owner's curated memory pool, for the `memory-embed-backlog`
   *  task that fills rung 4's vector sidecar.
   *
   *  ⚠ NOT an enrichment scope. The pool's vectors live beside it in
   *  `user_memory_vec`, not in `data_enrichment` — `EnrichmentScope` has
   *  no `memory` arm and adding one is a multi-commit arc through a
   *  closed vocabulary. Housekeeping is here only as the SCHEDULER for a
   *  token-spending backlog, which is the part it is genuinely good at.
   *  Absent (dbless harness) → the task no-ops. */
  userMemoryStore?: UserMemoryStore;
  /** D-172 P6 — transcription executor for file-enrichment producers
   *  over voice `data.file` records. Wired through `transcribe` from
   *  `bin.ts`; optional for deterministic producers and tests. The
   *  D-167 text alias layer deliberately does not wrap this callable:
   *  audio bytes are media payloads, not text fields that can be
   *  safely replaced with aliases before egress. */
  transcribe?: HousekeepingTranscribe;
  /** Content-addressed blob store for fetching mail / file bodies
   *  beyond the 64 KB inline cutoff. Producers reading CAS-stored
   *  values pull them through this. Optional for the same reason as
   *  `llm`. */
  blobs?: BlobStore;
  /** D-132 P2 — per-topic trust + pool-policy store. Read by the
   *  scheduler eligibility gate + the harness's per-record forceLayer
   *  threading. Optional for harness tests that drive deterministic
   *  producers (the trust gate is a no-op for `is_ai_surface: false`
   *  and trust state defaults to `'auto'` for them anyway). Production
   *  always wires it through `bin.ts`. */
  trustStore?: TrustStore;
  /** D-132 P2 — pool-policy-resolved force layer for the LLM /
   *  embeddings call this step makes. Set by the harness before each
   *  per-record `produce()` call from the topic's `pool_policy` and
   *  the global `allow_byok_background` master:
   *    - `!allow_byok_background`           → `'free'`
   *    - `pool_policy: 'free_only'`         → `'free'`
   *    - `pool_policy: 'byok_only'`         → `'byok'`
   *    - `pool_policy: 'free_then_byok'`    → `'any'`
   *  The harness's wrapped `llm` / `embed` callables inject
   *  `'llm.force_layer'` into the input map automatically using this
   *  field, so existing producers continue to call `ctx.llm(manifest,
   *  input)` without per-producer migrations. Producers that want a
   *  per-call override may set `'llm.force_layer'` explicitly on their
   *  input — the wrapper preserves any caller-supplied value. */
  llm_force_layer?: ForceLayer;
  /** D-167 — non-chat AI-egress PII alias tag source. When wired, the
   *  per-record enrichment harness seeds a run-local alias ledger from
   *  the source record's `MetaField.privacy`-tagged structured fields,
   *  aliases the LLM-bound packet's content before egress, and restores
   *  the model output (so the warehouse row + audit see real values,
   *  only the cloud/free-pool LLM sees aliases). Optional — absent leaves
   *  producer LLM calls byte-identical (the comfort default is a no-op
   *  until tags resolve). Production wires it through `bin.ts`. */
  enrichmentPiiTagSource?: EnrichmentPiiTagSource;
  /** D-133 — realtime event bus for housekeeping tasks that fan out
   *  state-transition events (e.g. the `confidence_drift_signal`
   *  producer firing `enrichment_drift_detected` on a severity
   *  crossing). Optional so deterministic core tasks + tests that
   *  don't exercise event fan-out keep working without supplying
   *  one. Production wires it through `bin.ts`. */
  eventBus?: EventBus;
  /** D-145 PA9 — work-entity store for producers that read across
   *  multiple work-entity rows (today: `task_duplicate_candidate`'s
   *  cross-Source candidate lookup). Per-record producers reading only
   *  their own scope's source records get those through the walker;
   *  cross-entity producers reach out to the store directly. Optional —
   *  harness tests + deterministic core tasks don't need it; production
   *  wires it through `bin.ts` on the same gate as the work-entity
   *  due-status sweep registration. */
  workEntityStore?: WorkEntityStore;
  /** D-145 § A.7.8 (Amended 2026-05-26) — typed per-topic tunable
   *  params accessor. Producers read user-effective values via
   *  `ctx.tunableParams.getNumber(topic, key)` / `getEnum(topic, key)`;
   *  the accessor returns override-or-default, validates type against
   *  the declaration, and clamps numbers to `[min, max]` defensively.
   *  Optional — harness tests + producers without declared tunables
   *  leave it undefined and the producer falls back to declaration
   *  defaults via the accessor stub. Production wires it from
   *  `createTunableParamsStore` in `bin.ts`. */
  tunableParams?: TunableParamsAccessor;
  /** D-145 § A.7.10 — content-addressed LLM result cache. AI producers
   *  opt in to cache reuse via the `compose_input` field on
   *  `runAIProducer`; identical inputs across distinct source records
   *  (forwarded mail bodies, repeated templates, signature blocks)
   *  reuse the previously-computed result without re-calling the
   *  model. Optional — harness tests + production cycles that lack
   *  the wiring leave it undefined and the wrapper degrades to a
   *  cache-miss path on every call. Production wires it from
   *  `createLlmResultCacheStore` in `bin.ts`. */
  llmResultCache?: LlmResultCacheStore;
  /** D-192 email flagship (E2b) — the live merged vendor registry
   *  (`liveVendorRegistry(localManifestStore)`). The `commitment_tracker`
   *  task resolves its contact-platform-reference scopes DECLARATIVELY via
   *  `scopesForCrmAlias('contact', registry)` (so Pipedrive's
   *  `entity:'person'` + any pack CRM join, never a hardcoded vendor list).
   *  Optional — absent ⇒ callers fall back to `CONNECTION_VENDOR_ENTITIES`
   *  (the built-in vendors); production wires it in
   *  `composeHousekeepingScheduler`. */
  resolveVendorRegistry?: () => ReadonlyArray<ConnectionVendorEntity>;
  /** D-192 email flagship (E2b) — the contact-engagements resolver closure
   *  the `commitment_tracker` producer fans in over. Captures the
   *  engagement store + the per-call `buildEngagementsResolverDeps` builder
   *  (the SAME resolver the WS-rpc / MCP read channels use), so the task
   *  gathers a contact's engagement rows without threading the store +
   *  resolver deps piece by piece. Optional — absent (dbless / test /
   *  pre-wire) ⇒ the `commitment_tracker` task no-ops; production wires it
   *  from `app.contactEngagementsResolveDepsRef` in
   *  `composeHousekeepingScheduler`. */
  resolveContactEngagements?: (
    args: EngagementsResolverArgs,
  ) => EngagementsResolverResult;
  /** D-192 email flagship (E3) — the extraction→proposal funnel. After the
   *  `commitment_tracker` task upserts a contact's row, it hands the produced
   *  commitments here; the funnel dedups on `commitment_id`, composes the
   *  `mail` evidence blob + the E1 direction/counterparty, and fires ONE
   *  held `commitment-propose` run per NEW commitment (the D-173 inbox
   *  review-then-approve funnel). Optional — absent (dbless / test / pre-wire)
   *  ⇒ the task produces enrichment rows without proposing. Wired in
   *  `composeHousekeepingScheduler` from the F1 proposal `fire` runtime ref +
   *  a dedicated `commitment_id` ledger + `contactStore.resolveCanonicalEmail`. */
  commitmentProposalFunnel?: (input: {
    subject_email: string;
    commitments: readonly TrackedCommitment[];
  }) => Promise<{ proposed: number; skipped: number }>;
}

export type HousekeepingInvalidateReason =
  | 'source_update'
  | 'source_delete'
  | 'recipe_upgrade'
  | 'config_change'
  /** D-136 §A.5 P5 — emitted by the four new cascade primitives.
   *  Existing housekeeping tasks (`thread_signals`, audit-compaction)
   *  ignore these; the queue drain consumer (P5b/P6) opts in. */
  | 'producer_upgrade'
  | 'upstream_enrichment'
  | 'identity_change'
  | 'connection_delete'
  /** D-136 §A.14.1 P5b — emitted by `cascadeForExternalContextPulseChange`.
   *  Source_id carries the `context_id` whose pulse value diverged
   *  from the previously observed one. */
  | 'external_context_pulse_change'
  /** D-139 P3 § A.10 — emitted by `cascadeForEngagementEvent`. The
   *  engagement substrate (D-139 P1a.1+) holds engagement rows +
   *  edges outside the enrichment table; this cascade reason walks
   *  engagement_edges → affected deal/contact/account targets +
   *  invalidates aggregate enrichment rows whose `aggregates_from`
   *  references the engagement's per-type source scope. Source_id
   *  carries the engagement target_id (e.g. `hubspot_email_47291`);
   *  scope carries the engagement's per-type platform-reference
   *  scope (e.g. `connection.api.hubspot.email`). */
  | 'engagement_event';

export interface HousekeepingInvalidateHint {
  scope?: string;
  topic?: string;
  source_id?: string;
  reason: HousekeepingInvalidateReason;
}

// ────────────────────────────────────────────────────────────────
// Task instance — registered with the registry.
// ────────────────────────────────────────────────────────────────

export interface HousekeepingTaskInstance {
  meta: HousekeepingTaskMeta;
  /** D-132 P2 — enrichment topic backing this task. Stamped by
   *  `buildEnrichmentProducerTask` so the scheduler trust gate +
   *  harness pool-policy resolver can look up trust state per topic
   *  without re-deriving from `meta.id`. Absent on `kind: 'core'`
   *  tasks (deterministic maintenance — the trust gate is a no-op
   *  for them). */
  topic?: EnrichmentTopic;
  /** D-132 P2 — true iff this task wraps an AI-surface enrichment
   *  producer (`producer.ai_surface !== undefined && producer
   *  .estimate_per_record_tokens() > 0`). Drives both the trust gate
   *  default (AI surfaces default to `'manual'`, deterministic to
   *  `'auto'`) + the pause-AI window (only AI surfaces honour the
   *  `pause_background_ai_until` global). Absent on core tasks. */
  is_ai_surface?: boolean;
  /** D-136 §A.7 P6 — per-record token estimate, mirrored from the
   *  producer's `estimate_per_record_tokens()`. The walk-cap planner
   *  multiplies this by pending-row count to size the per-pool
   *  budget gate; without it, the drain task projects a conservative
   *  `DEFAULT_AI_TOKEN_ESTIMATE` placeholder which over- or under-
   *  budgets producers whose true cost diverges. Stamped by
   *  `buildEnrichmentProducerTask`; absent on core tasks (deterministic
   *  maintenance — token cost is implicitly 0). */
  token_estimate_per_record?: number;
  /** Process a slice from the cursor's position; advance cursor.
   *  Return `'yield'` when budget exhausted (cursor preserves
   *  progress) or `'complete'` when no work remains (cursor
   *  becomes `{ kind: 'complete' }`). The engine resumes from the
   *  cursor on the next idle cycle. */
  step(
    ctx: HousekeepingContext,
    cursor: HousekeepingCursor,
    budget_ms: number,
  ): Promise<HousekeepingStepResult>;
  /** Optional invalidation hook — when a source write would make
   *  the task's cursor potentially stale, the cascade engine calls
   *  this to flip `last_status` from `'complete'` back to
   *  `'pending'` so the next idle cycle picks the task up. Tasks
   *  walking append-only sources (e.g. `audit-compaction`) don't
   *  need this; tasks reading mutable state opt in. */
  onInvalidate?(ctx: HousekeepingContext, hint: HousekeepingInvalidateHint): void;
}

// ────────────────────────────────────────────────────────────────
// Registry — singleton + factory for tests.
// ────────────────────────────────────────────────────────────────

export interface HousekeepingRegistry {
  register(task: HousekeepingTaskInstance): void;
  get(task_id: string): HousekeepingTaskInstance | undefined;
  list(): ReadonlyArray<HousekeepingTaskInstance>;
  /** Topological sort honouring `meta.depends_on`. Cycles throw —
   *  the registry is hand-authored so a cycle is a programming
   *  error, not a runtime condition. */
  topoSort(): ReadonlyArray<HousekeepingTaskInstance>;
  unregister(task_id: string): void;
  clear(): void;
}

export const createHousekeepingRegistry = (): HousekeepingRegistry => {
  const tasks = new Map<string, HousekeepingTaskInstance>();

  return {
    register(task) {
      if (tasks.has(task.meta.id)) {
        throw new Error(`housekeeping task '${task.meta.id}' already registered`);
      }
      tasks.set(task.meta.id, task);
    },
    get(task_id) {
      return tasks.get(task_id);
    },
    list() {
      return [...tasks.values()];
    },
    topoSort() {
      return topologicalSort([...tasks.values()]);
    },
    unregister(task_id) {
      tasks.delete(task_id);
    },
    clear() {
      tasks.clear();
    },
  };
};

const defaultRegistry: HousekeepingRegistry = createHousekeepingRegistry();

/** Add a task to the per-process default registry. `bin.ts` calls
 *  this at boot for every built-in task. */
export const registerHousekeepingTask = (task: HousekeepingTaskInstance): void => {
  defaultRegistry.register(task);
};

/** D-129 P2 — drop a single task by id. Used by the connection-upsert
 *  hook to deregister vendor reconciliation tasks for connections the
 *  user just deleted. The task's cursor in `housekeeping_state`
 *  survives so re-enrollment under the same name picks up where it
 *  left off (per spec § A.5). No-op when the id isn't registered. */
export const unregisterHousekeepingTask = (task_id: string): void => {
  defaultRegistry.unregister(task_id);
};

export const getHousekeepingTask = (task_id: string): HousekeepingTaskInstance | undefined =>
  defaultRegistry.get(task_id);

export const listHousekeepingTasks = (): ReadonlyArray<HousekeepingTaskInstance> =>
  defaultRegistry.list();

export const topoSortHousekeepingTasks = (): ReadonlyArray<HousekeepingTaskInstance> =>
  defaultRegistry.topoSort();

/** Drop every entry from the default registry. Tests + module
 *  reload only — production code never calls this. */
export const clearDefaultHousekeepingRegistry = (): void => {
  defaultRegistry.clear();
};

// ────────────────────────────────────────────────────────────────
// Topological sort
// ────────────────────────────────────────────────────────────────

/** Kahn's algorithm — emits nodes in dependency-respecting order.
 *  Stable secondary sort by `meta.id` for deterministic output
 *  across registrations. */
const topologicalSort = (
  tasks: ReadonlyArray<HousekeepingTaskInstance>,
): ReadonlyArray<HousekeepingTaskInstance> => {
  const byId = new Map(tasks.map((t) => [t.meta.id, t]));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const task of tasks) {
    inDegree.set(task.meta.id, 0);
    dependents.set(task.meta.id, []);
  }

  for (const task of tasks) {
    for (const dep of task.meta.depends_on ?? []) {
      if (!byId.has(dep)) {
        // Missing dependency — task can never run. Treat as
        // unsatisfied indegree of 1 so the task is excluded from
        // the emitted order. The scheduler will see it as
        // perpetually pending; surfaces in the Settings UI as
        // "waiting on missing dep". Registry doesn't throw — a
        // dependency may legitimately ship in a later release.
        inDegree.set(task.meta.id, (inDegree.get(task.meta.id) ?? 0) + 1);
        continue;
      }
      inDegree.set(task.meta.id, (inDegree.get(task.meta.id) ?? 0) + 1);
      dependents.get(dep)!.push(task.meta.id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }
  queue.sort();

  const out: HousekeepingTaskInstance[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const task = byId.get(id);
    if (task) out.push(task);
    const newlyReady: string[] = [];
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) newlyReady.push(dependent);
    }
    newlyReady.sort();
    queue.push(...newlyReady);
  }

  if (out.length !== tasks.length) {
    // Could be a cycle OR a chain blocked by a missing dependency.
    // Distinguish: any task with all deps present but indegree > 0
    // is in a cycle.
    const remaining = tasks.filter((t) => !out.includes(t));
    const cycleMembers = remaining.filter((t) =>
      (t.meta.depends_on ?? []).every((dep) => byId.has(dep)),
    );
    if (cycleMembers.length > 0) {
      throw new Error(
        `housekeeping registry cycle detected involving: ${cycleMembers
          .map((t) => t.meta.id)
          .join(', ')}`,
      );
    }
  }

  return out;
};
