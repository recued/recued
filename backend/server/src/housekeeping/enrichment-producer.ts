/** D-123 Phase 4 — Enrichment producer harness.
 *
 *  Producers themselves are pure: source record → enrichment value
 *  (or null when the record carries no signal). Cursor advancement,
 *  hash-based skip-rule, upsert authorship, and registry topic
 *  bookkeeping all live on the harness so each new producer is one
 *  small file plus one entry on `bin.ts` registration.
 *
 *  Skip rule: a source record is skipped iff a `data_enrichment` row
 *  for the same `(topic, scope, target_id, authored_by)` already
 *  exists, is not stale, and its `source_record_hash` matches the
 *  walker's hash of the current source. Cascade-engine staling +
 *  hash mismatch are the two paths back into producer execution.
 *
 *  Cursor: forward-only `{ kind: 'topic', topic, scope?,
 *  max_target_id_seen }`. Aggregate-policy producers rely on
 *  `recompute_cadence` (out-of-scope for P4 — wired through the
 *  scheduler in a later D) to periodically reset the cursor; for
 *  P4 the skip-rule alone gives correct first-walk behaviour and
 *  the cascade-engine staling pathway covers in-window drift.
 *
 *  Stale-row sweep: each step also re-derives stale rows authored
 *  by this producer (FK CASCADE took care of the row payload + sidecar
 *  on the source-side cascade hook; the harness re-runs `produce()` on
 *  the source record so the row goes back to fresh). This is the
 *  partner to the eager cascade engine — eager marks-stale; harness
 *  sweeps + re-derives.
 *
 *  Spec: D-123 §4.1. */

import {
  ENRICHMENT_REGISTRY,
  HOUSEKEEPING_MIN_TASK_BUDGET_MS,
  assertEnrichmentTrustDefaults,
  assertEnrichmentLifecycleDefaults,
  computeHousekeepingMetaTags,
  isOriginActorAccepted,
  readSourceOriginActor,
  type EnrichmentDefinition,
  type EnrichmentRecomputeCadence,
  type EnrichmentScope,
  type EnrichmentTopic,
  type HousekeepingCursor,
  type HousekeepingStepResult,
} from '@recued/contracts';
import { LLMError, type ForceLayer } from '@recued/llm';

import type {
  HousekeepingContext,
  HousekeepingInvalidateHint,
  HousekeepingTaskInstance,
} from './registry.js';
import { isPoolUnsatisfiable } from './pool-unsatisfiable.js';
import { wrapHousekeepingCtxForRecord } from './enrichment-pii-egress.js';
import type { SourceCollectionWalker, SourceRecord } from './source-walkers.js';
import type { ConsumesExternalContextEntry } from '../storage/external-context-pulse.js';
import { parseRetryAtToken } from '../storage/enrichment-store.js';
import {
  appendTaskErrorEntry,
  isByokAllowedForBackground,
  type TrustStore,
} from './trust-store.js';

/** Standard per-batch row count. Bounds memory + lets the scheduler
 *  yield between batches when budget tightens. Same magnitude as the
 *  P3 task batch sizes for predictable behavior. */
const ENRICHMENT_BATCH_SIZE = 200;

/** Stale-sweep batch — smaller because each pass re-runs `produce()`
 *  per row (which can do nontrivial SQL aggregation per call); 50
 *  keeps a single sweep step under the typical 60s housekeeping
 *  budget for thread_signals-shaped producers. */
const STALE_SWEEP_BATCH_SIZE = 50;

/** Authored-by stamp prefix for housekeeping-emitted enrichment rows.
 *  Distinguishes harness writes from recipe-emitted writes in the
 *  Memory tab + audit feeds. The matching prefix is also used by the
 *  P3 deterministic risk-patterns + link-discovery tasks. */
export const HOUSEKEEPING_AUTHORED_BY_PREFIX = 'system.housekeeping';

/** Compose the `authored_by` stamp for a housekeeping enrichment
 *  producer's writes. Stable across cycles so the unique
 *  `(topic, scope, target_id, authored_by)` index treats them as
 *  upserts rather than duplicate rows. */
export const enrichmentProducerAuthoredBy = (topic: EnrichmentTopic): string =>
  `${HOUSEKEEPING_AUTHORED_BY_PREFIX}.${topic}`;

/** Producer output. `value` is the enrichment value; sidecar fields
 *  feed the topic's `vector_index` / `fts` sidecar tables when
 *  declared on the registry. Returning `null` from `produce()` skips
 *  the record entirely (source has no signal worth recording).
 *
 *  D-136 P3 — bistemporal + dedup hashes flow through optional fields
 *  on the producer's per-call output. The harness threads them into
 *  the upsert so per-record producers don't need to know the storage
 *  shape. Per-record producers stamp `event_at` from the source's own
 *  clock (D-120 P7.5 + audit §20.2 fix); aggregate / perspective /
 *  upstream-consuming producers compose `input_fingerprint_hash` via
 *  `computeInputFingerprintHash` and pass the result here. NULL on
 *  any field falls back to the harness defaults — `source_record_hash`
 *  for the per-record fingerprint degenerate case, harness clock
 *  for `event_at` (with a one-cycle warning that the producer didn't
 *  thread the source clock). */
export interface EnrichmentProducerOutput {
  value: unknown;
  sidecar_vector?: Buffer;
  sidecar_text?: string;
  /** D-136 P3 — source's own event time (mail Date: header,
   *  calendar start.dateTime, file mtime, platform-record snapshot_at).
   *  When undefined, the harness logs a one-cycle warning and falls
   *  back to ctx.now() — temporary; every producer should populate. */
  event_at?: number;
  /** D-136 P3 — resolved provider model id captured at LLM-call time
   *  (`'openai:gpt-4o-mini'`, `'anthropic:claude-haiku-4-5'`). Threaded
   *  by AI producers that called `ctx.llmWithMeta`. Deterministic
   *  producers leave undefined. */
  model_id?: string;
  /** D-136 P3 — `'fnv1a:<8-hex>'` per `computeProducerVersionHash`.
   *  Producers compute once at boot and pass the same hash on every
   *  per-call output; harness threads to upsert. */
  producer_version_hash?: string;
  /** D-136 P3 — composed input-fingerprint hash. Per-record producers
   *  may omit (harness sets it to `source_record_hash`); aggregate /
   *  perspective / upstream-consuming producers compose explicitly. */
  input_fingerprint_hash?: string;
  /** D-136 P3 — ingredient slug the LLM call used (`'ai-classify'`,
   *  `'ai-extract'`). Distinct from `model_id`. */
  ingredient_slug?: string;
}

/** What every housekeeping enrichment producer must implement. The
 *  harness wraps this into a `HousekeepingTaskInstance` via
 *  `buildEnrichmentProducerTask`.
 *
 *  Parameterised on `TData` (D-131 A.4) so per-scope producers can
 *  type their `source_record.data` against the canonical record shape
 *  their scope owns. Mail / calendar / file producers default to
 *  `CollectionRecord`; contact producers use `ContactRecord` (separate
 *  per-pair table with its own schema). */
/** D-132 A.6 — declared scope-of-read for a producer. The Run-Now
 *  dialog renders this alongside the token-cost preview, and the
 *  per-topic detail drawer shows it inline. The author lists the
 *  collections their producer reads + a curated short list of field
 *  paths users should know are inspected. Hard-required at producer
 *  registration: `buildEnrichmentProducerTask` throws when missing or
 *  empty. */
export interface ProducerScopeReadDeclaration {
  /** Canonical collection name — `'data.mail'`, `'data.calendar'`,
   *  `'data.contact'`, `'data.file'`, or an enrichment scope. The UI
   *  uses this to render record counts via the standard collection
   *  size query. */
  collection: string;
  /** 3-5 field paths the user should know are inspected. Not the full
   *  read set — just the load-bearing identifiers so the trust dialog
   *  can communicate intent. Examples: `['subject', 'body_preview',
   *  'from']` for a mail-AI producer. */
  sample_field_paths: ReadonlyArray<string>;
}

export interface HousekeepingEnrichmentProducer<TData = import('@recued/contracts').CollectionRecord> {
  /** Registry key — must have `producer_kind: 'housekeeping'`.
   *  `buildEnrichmentProducerTask` validates this at construction. */
  topic: EnrichmentTopic;
  /** Source collection scope the producer reads. Must match one of
   *  the registry topic's `valid_scopes`. */
  source_scope: EnrichmentScope;
  /** D-136 P3 — producer's current code+model+prompt+adapter+ingredients
   *  fingerprint, declared statically at module load (typically via
   *  `computeProducerVersionHash`). When present, the harness skip rule
   *  extends from source-hash-only to also require
   *  `existing.producer_version_hash === producer.producer_version_hash`
   *  — so a producer-version bump invalidates existing rows even when
   *  source content is unchanged. Producers that haven't retrofitted
   *  to D-136 P3 leave it undefined; the skip rule falls back to
   *  legacy source-hash-only behavior.
   *
   *  D-145 § A.7.8 (Amended 2026-05-26) widens this slot to accept a
   *  `(ctx) => string` callable. Producers with user-tunable params
   *  declare a function that folds the topic's current
   *  `tunable_params_hash` into the version-hash composition; the
   *  harness invokes per-cycle so a user-side tune (via Settings →
   *  Housekeeping → topic card) bumps the effective hash and
   *  invalidates existing rows on the next walk even when source
   *  content is unchanged. The static-string + undefined paths stay
   *  byte-stable for pre-amendment producers. */
  producer_version_hash?:
    | string
    | ((ctx: HousekeepingContext) => string);
  /** D-131 A.3 — which AI surface the producer requires (when its
   *  per-record token estimate is positive). `'chat'` covers the
   *  `executeLLM` path (summary / purpose / action_items …);
   *  `'embeddings'` covers `executeEmbedding` (embedding /
   *  semantic_cluster). Deterministic producers omit the field —
   *  the Run-Now dialog skips the AI-availability probe entirely
   *  for zero-cost producers, so the field is irrelevant there.
   *  Defaults treated as `'chat'` for backward-compat. */
  ai_surface?: 'chat' | 'embeddings';
  /** Per-record producer call. Returns the value to upsert into the
   *  enrichment table, or `null` to skip (source carries no signal). */
  produce(
    ctx: HousekeepingContext,
    source_record: SourceRecord<TData>,
  ): Promise<EnrichmentProducerOutput | null>;
  /** Token-cost preview shown on Settings → Housekeeping → Run now.
   *  Returns expected per-record cost in tokens; 0 for deterministic
   *  producers. UI multiplies by current source-collection size. */
  estimate_per_record_tokens(): number;
  /** Optional: producer-specific cadence override. Defaults to the
   *  registry topic's `recompute_cadence`. P4 records but doesn't
   *  consume — wired through the scheduler in a later D. */
  recompute_cadence?: EnrichmentRecomputeCadence;
  /** D-132 A.6 — declared scope-of-read. Hard-required: the validator
   *  in `buildEnrichmentProducerTask` rejects producers that omit it
   *  or pass an empty list. Each entry's `sample_field_paths` must
   *  also be non-empty. */
  scope_read_declaration: ReadonlyArray<ProducerScopeReadDeclaration>;
  /** D-136 §A.14.1 P5b — external-context dependencies. Producers
   *  that read external state at compute time (vendor APIs, web
   *  search, MCP tool results, third-party data) declare each
   *  dependency by stable `id` so the substrate can invalidate
   *  consumed rows when the upstream pulse changes. Two producers
   *  reading the same external state should declare the same `id`
   *  so a single pulse change fans out to both.
   *
   *  Optional — most producers are pure functions of warehouse
   *  records + don't need this. AI producers calling out to a vendor
   *  API mid-compute are the canonical case. */
  consumes_external_context?: ReadonlyArray<ConsumesExternalContextEntry>;
}

export interface BuildEnrichmentProducerTaskOptions<TData = import('@recued/contracts').CollectionRecord> {
  producer: HousekeepingEnrichmentProducer<TData>;
  /** Walker for the producer's `source_scope`. P4's
   *  `createSourceWalkerRegistry` ships only the mail walker;
   *  callers wiring a producer for a different scope must supply
   *  the walker for that scope here. The walker's `TData` must
   *  match the producer's `TData` — TS enforces at the call site. */
  walker: SourceCollectionWalker<TData>;
  /** D-145 PA9 (multi-scope task-id substrate) — optional suffix for
   *  the task id, enabling multiple producers to share one topic across
   *  distinct `source_scope` values without colliding on the
   *  `housekeeping_state` row key.
   *
   *  Without suffix: id = `enrichment.${topic}` (back-compat).
   *  With suffix:    id = `enrichment.${topic}.${task_id_suffix}`.
   *
   *  Use only when the same topic legitimately has multiple scopes
   *  (e.g. `open_loop_pressure` over `contact` + `project`). The
   *  `(topic, scope, target_id, authored_by)` storage uniqueness gate
   *  already separates rows by scope — this suffix exists solely for
   *  the scheduler-level task id, not for storage.
   *
   *  Convention: suffix equals `source_scope` (validated at construction
   *  — characters limited to `[a-z0-9_]` so the composed id stays a
   *  valid identifier across logs, audit rows, and scheduler tables). */
  task_id_suffix?: string;
}

/** D-132 P2 — resolve effective `ForceLayer` for an AI-surface
 *  producer's per-record LLM / embeddings call. Deterministic
 *  producers + harness contexts without a trust store wired short-
 *  circuit to `'any'` (the executor default; no behavioural change
 *  vs. pre-D-132). The runtime collapses the per-topic policy when
 *  the global `allow_byok_background` master is off — `'free_only'`,
 *  `'free_then_byok'`, `'byok_only'` all become `'free'`. */
const resolveEffectiveLayer = (
  ctx: HousekeepingContext,
  topic: EnrichmentTopic,
  isAiSurface: boolean,
  trustStore: TrustStore | undefined,
): ForceLayer => {
  if (!isAiSurface) return 'any';
  if (!trustStore) return 'any';
  const trust = trustStore.read(topic, true);
  const byokAllowed = isByokAllowedForBackground(ctx.db);
  if (!byokAllowed) return 'free';
  if (trust.pool_policy === 'free_only') return 'free';
  if (trust.pool_policy === 'byok_only') return 'byok';
  return 'any'; // 'free_then_byok' — match resolver's free-before-BYOK default.
};

/** D-132 P2 — derive a per-step ctx that carries the effective force
 *  layer and a wrapped `llm` / `embed` so producer call sites stay
 *  pool-policy-agnostic. The wrapper merges `'llm.force_layer'` into
 *  the input map *only when absent* — producer-side overrides win,
 *  matching the executor's `input['llm.force_layer'] ?? ctx?.forceLayer`
 *  precedence.
 *
 *  D-136 P3 — `llmWithMeta` is wrapped on the same precedence so the
 *  producer wrapper can stamp `model_id` onto the enrichment row. */
const wrapCtxWithForceLayer = (
  base: HousekeepingContext,
  layer: ForceLayer,
): HousekeepingContext => {
  const baseLlm = base.llm;
  const baseLlmWithMeta = base.llmWithMeta;
  const baseEmbed = base.embed;
  const baseTranscribe = base.transcribe;
  return {
    ...base,
    llm_force_layer: layer,
    ...(baseLlm
      ? {
          llm: (manifest, input) =>
            baseLlm(manifest, { 'llm.force_layer': layer, ...input }),
        }
      : {}),
    ...(baseLlmWithMeta
      ? {
          llmWithMeta: (manifest, input) =>
            baseLlmWithMeta(manifest, { 'llm.force_layer': layer, ...input }),
        }
      : {}),
    ...(baseEmbed
      ? {
          embed: (manifest, input) =>
            baseEmbed(manifest, { 'llm.force_layer': layer, ...input }),
        }
      : {}),
    ...(baseTranscribe
      ? {
          transcribe: (request, options) =>
            baseTranscribe(request, { force_layer: layer, ...options }),
        }
      : {}),
  };
};

/** Wrap a `HousekeepingEnrichmentProducer` into the
 *  `HousekeepingTaskInstance` shape the registry consumes. */
export const buildEnrichmentProducerTask = <TData>(
  opts: BuildEnrichmentProducerTaskOptions<TData>,
): HousekeepingTaskInstance => {
  const { producer, walker, task_id_suffix } = opts;
  if (task_id_suffix !== undefined && !/^[a-z0-9_]+$/.test(task_id_suffix)) {
    throw new Error(
      `enrichment_task_id_suffix_malformed: producer for topic '${producer.topic}' passed task_id_suffix='${task_id_suffix}' — must match /^[a-z0-9_]+$/`,
    );
  }

  // Validate registry pre-conditions at task construction so a
  // misconfigured producer fails fast rather than at first cycle.
  const definition = ENRICHMENT_REGISTRY[producer.topic];
  if (!definition) {
    throw new Error(`enrichment_topic_unknown: '${producer.topic}'`);
  }
  if (definition.producer_kind !== 'housekeeping') {
    throw new Error(
      `enrichment_producer_kind_mismatch: topic '${producer.topic}' has producer_kind '${definition.producer_kind}', expected 'housekeeping'`,
    );
  }
  if (definition.shape === 'per_record') {
    const validScopes: ReadonlyArray<string> = definition.valid_scopes ?? [];
    if (!validScopes.includes(producer.source_scope)) {
      throw new Error(
        `enrichment_scope_unsupported: topic '${producer.topic}' does not support scope '${producer.source_scope}'`,
      );
    }
  }

  // D-132 A.6 — scope_read_declaration is hard-required. Validator
  // rejects empty top-level lists + per-entry empty sample_field_paths
  // so the Run-Now dialog + detail drawer always have something to
  // render.
  if (!Array.isArray(producer.scope_read_declaration) || producer.scope_read_declaration.length === 0) {
    throw new Error(
      `enrichment_scope_read_declaration_missing: producer for topic '${producer.topic}' must declare at least one scope_read_declaration entry`,
    );
  }
  for (const entry of producer.scope_read_declaration) {
    if (typeof entry.collection !== 'string' || entry.collection === '') {
      throw new Error(
        `enrichment_scope_read_declaration_malformed: producer for topic '${producer.topic}' declared an entry without a collection name`,
      );
    }
    if (!Array.isArray(entry.sample_field_paths) || entry.sample_field_paths.length === 0) {
      throw new Error(
        `enrichment_scope_read_declaration_empty_fields: producer for topic '${producer.topic}' entry for collection '${entry.collection}' must declare at least one sample_field_paths entry`,
      );
    }
  }

  // ⛔ THIS PREDICATE NEEDS TWO DECLARATIONS TO AGREE, AND FORGETTING ONE
  // FAILS OPEN. `summary`, `purpose` and `action_items` each declared a
  // positive token estimate and omitted `ai_surface`, so `isAiSurface`
  // came out FALSE for three producers that call `executeLLM`. Everything
  // protecting the owner keys on this flag, so all of it silently
  // disengaged at once:
  //
  //   - `resolveEnrichmentTrustDefault(topic, false)` returns 'auto'
  //     instead of 'manual' → idle-eligible, running AI on housekeeping
  //     cycles with no owner action;
  //   - `isEligibleForIdleCycle`'s `isAiSurface && isAiPaused(...)` is
  //     skipped → the top-bar Pause-AI control did not stop them;
  //   - `wrapCtxWithForceLayer` below is applied only when `isAiSurface`
  //     → the owner's `pool_policy` (free_only / byok_only) was not
  //     enforced for their calls.
  //
  // Each producer's header claimed the token estimate alone made it
  // "manual-only by construction", and `ai_surface`'s own doc says
  // "defaults treated as 'chat' for backward-compat" — neither is what
  // this line does. So the omission is asserted rather than defaulted:
  // guessing 'chat' here would make the SAFE reading of a missing field
  // depend on a comment, and the failure it hides is "AI ran without
  // being asked".
  const tokenEstimate = producer.estimate_per_record_tokens();
  if (tokenEstimate > 0 && producer.ai_surface === undefined) {
    throw new Error(
      `enrichment_ai_surface_undeclared: topic '${producer.topic}' estimates `
      + `${String(tokenEstimate)} tokens/record but declares no \`ai_surface\`. `
      + `A producer that spends tokens must name its surface ('chat' | `
      + `'embeddings') — without it the topic defaults to trust_state 'auto', `
      + `ignores the Pause-AI window, and bypasses the owner's pool policy.`,
    );
  }

  // D-132 A.2 — trust-default consistency check. Throws when registry-
  // declared default_trust_state is incompatible with the producer's
  // ai_surface (e.g. 'auto' on an AI producer).
  const isAiSurface = producer.ai_surface !== undefined && tokenEstimate > 0;
  assertEnrichmentTrustDefaults(producer.topic, isAiSurface);
  // D-136 §A.8 — lifecycle / temporal-class / identity-aggregation
  // gates. Throws when the registry entry violates any of the eight
  // gates (PSI on non-stable_truth, missing as_of_field, time_bound
  // + recompute_on_drift, etc.).
  assertEnrichmentLifecycleDefaults(producer.topic);

  // D-161 P2 — input-provenance trust: the producer's accepted
  // `origin_actor` set. A declared list must be non-empty — an empty
  // list means "accept nothing" (reject every row), almost certainly a
  // misconfiguration; the conservative `user_self` + `system` default is
  // reached by *omitting* the field, not by declaring `[]`. Undeclared
  // (undefined) is the common, valid case (N.9 MUST / TR-7).
  // The literal registry union is assignable to `EnrichmentDefinition`
  // (same as the `computeHousekeepingMetaTags({ def: definition })` pass
  // below), but reading an optional field that no literal entry declares
  // yet needs the interface view.
  const originAcceptance = (definition as EnrichmentDefinition).origin_acceptance;
  if (originAcceptance !== undefined && originAcceptance.length === 0) {
    throw new Error(
      `enrichment_origin_acceptance_empty: topic '${producer.topic}' declares an empty origin_acceptance — omit the field for the conservative user_self+system default instead of declaring []`,
    );
  }

  const authored_by = enrichmentProducerAuthoredBy(producer.topic);
  const id =
    task_id_suffix !== undefined
      ? `enrichment.${producer.topic}.${task_id_suffix}`
      : `enrichment.${producer.topic}`;
  const description = definition.description;

  // D-132 P2 — the static `idle_eligible = estimate_per_record_tokens()
  // === 0` derivation is gone. The scheduler resolves eligibility per
  // cycle from the per-topic trust state (registry default folded in
  // when no row persisted) + global pause-AI window. Stamping
  // `idle_eligible: undefined` on the meta keeps the back-compat
  // semantics (treated-as-true when undefined) for callers that don't
  // wire a trust store — they get the legacy "always eligible" shape
  // and the trust gate is short-circuited at the scheduler.

  type TopicCursor = Extract<HousekeepingCursor, { kind: 'topic' }>;

  const initialCursor = (): TopicCursor => ({
    kind: 'topic',
    topic: producer.topic,
    scope: producer.source_scope,
    max_target_id_seen: '',
  });

  // D-136 §A.7 P6 — capture the per-record token estimate once so the
  // walk-cap planner's `collectProducerInfos` reads the lossless value
  // instead of the drain task's `DEFAULT_AI_TOKEN_ESTIMATE = 200`
  // placeholder. The producer's `estimate_per_record_tokens()` is the
  // canonical source — for AI-surface producers it composes the
  // expected prompt + completion budget; for deterministic ones it
  // returns 0 (planner skips them in the budget pass).
  const tokenEstimatePerRecord = producer.estimate_per_record_tokens();

  return {
    meta: {
      id,
      description,
      interruptible: true,
      kind: 'enrichment',
      // idle_eligible deliberately omitted — scheduler trust gate
      // (D-132 P2) resolves per cycle from `enrichment_trust`.
      // D-134 P3 — auto-derive + author + surface merged tag set.
      tags: computeHousekeepingMetaTags({ def: definition, isAiSurface }),
    },
    topic: producer.topic,
    is_ai_surface: isAiSurface,
    token_estimate_per_record: tokenEstimatePerRecord,

    async step(
      ctx: HousekeepingContext,
      cursor: HousekeepingCursor,
      budget_ms: number,
    ): Promise<HousekeepingStepResult> {
      const start = ctx.now();
      // Cursor mismatch (first run, or persistence drift) →
      // start from empty.
      const topicCursor: TopicCursor =
        cursor.kind === 'topic' && cursor.topic === producer.topic
          ? cursor
          : initialCursor();
      let max_target_id_seen = topicCursor.max_target_id_seen;

      const checkBudget = (): boolean => ctx.now() - start >= budget_ms;

      // ── D-132 P2 — pool-policy → effective ForceLayer ──────────
      // Resolved once per step (trust state + global config don't
      // change mid-step in any contended case we care about). The
      // wrapped ctx propagates `llm.force_layer` into producer
      // `ctx.llm` / `ctx.embed` calls automatically; producers stay
      // pool-policy-agnostic and continue to call
      // `ctx.llm(manifest, input)` exactly as before.
      const effectiveLayer = resolveEffectiveLayer(ctx, producer.topic, isAiSurface, ctx.trustStore);
      const stepCtx = isAiSurface ? wrapCtxWithForceLayer(ctx, effectiveLayer) : ctx;

      // Skip-and-log helper — both walk paths funnel `produce()` calls
      // through this. When the per-topic pool policy can't be
      // satisfied (e.g. `free_only` with empty free pool), the LLM
      // executor throws `LLMError('AI_LLM_UNAVAILABLE')` carrying the
      // forced layer in `details.forceLayer`; we translate that into a
      // soft yield + a `last_errors_json` ring-buffer entry so the
      // task isn't credited with a `consecutive_errors` bump (which
      // would auto-disable after 3 failures). All other producer
      // errors are recoverable per-row failures (D-136 §A.6 / audit §9
      // P6) — `runProduce` returns a `producer_failure` outcome so
      // both walk paths can record the failure, escalate via the
      // backoff schedule, and advance past the row instead of
      // throwing the entire step.
      type ProduceOutcome =
        | { kind: 'output'; output: EnrichmentProducerOutput | null }
        // ⛔ `layer` is OPTIONAL because not every unsatisfiable state is a
        // pool-LAYER verdict: an unconfigured transcription slot and a spent
        // daily cap are server-wide, and reporting them as `forceLayer=free`
        // would send a reader to the wrong setting.
        | { kind: 'pool_unsatisfiable'; layer?: 'free' | 'byok'; message: string }
        | { kind: 'producer_failure'; reason: string };
      const runProduce = async (record: SourceRecord<TData>): Promise<ProduceOutcome> => {
        // D-167 — non-chat AI-egress PII aliasing. Wrap the per-record ctx so
        // an AI producer's `ctx.llm` / `ctx.llmWithMeta` calls alias known PII
        // (seeded from this record's MetaField.privacy-tagged structured
        // fields) before egress and restore the model output before the
        // producer parses it. A no-op (returns `stepCtx`) for deterministic
        // producers (gated on `isAiSurface`) and whenever no tag source / tags
        // / seed values resolve — byte-identical to pre-D-167.
        const recordCtx = isAiSurface
          ? wrapHousekeepingCtxForRecord(stepCtx, producer.source_scope, record.data)
          : stepCtx;
        try {
          const output = await producer.produce(recordCtx, record);
          return { kind: 'output', output };
        } catch (e) {
          // ⛔⛔ D-262 — THE CODES THAT MEAN "WAIT", NOT "THIS ROW IS BROKEN".
          // Anything falling through to `producer_failure` below gets per-row
          // backoff and is `permanently_failed` at attempt 5 with no
          // auto-retry — correct for a bad row, catastrophic for a server-wide
          // condition the owner is about to fix. An unconfigured
          // `transcription_slot` and a spent daily cap both clear on their
          // own; punishing rows for them means the rows are STILL dead after
          // the fix, and the only thing that would have revived them is the
          // call the condition was refusing.
          if (e instanceof LLMError && isPoolUnsatisfiable(e) && e.code !== 'AI_LLM_UNAVAILABLE') {
            return { kind: 'pool_unsatisfiable', message: e.message };
          }
          if (
            e instanceof LLMError &&
            e.code === 'AI_LLM_UNAVAILABLE' &&
            (effectiveLayer === 'free' || effectiveLayer === 'byok')
          ) {
            const detailLayer =
              typeof (e.details as { forceLayer?: unknown } | undefined)?.forceLayer === 'string'
                ? ((e.details as { forceLayer?: string }).forceLayer as string)
                : undefined;
            // The match resolver attaches `forceLayer` on the failure
            // details; if the producer made an internal LLM call with
            // a different `llm.force_layer` (today nobody does, but
            // it's possible) the layers won't agree and we treat the
            // mismatched-layer case as a recoverable per-row failure
            // (the row gets backoff + retry like any other transient
            // error). Missing `forceLayer` on details (older
            // callsites) defaults to trusting our forced layer.
            if (detailLayer === undefined || detailLayer === effectiveLayer) {
              return { kind: 'pool_unsatisfiable', layer: effectiveLayer, message: e.message };
            }
          }
          // P6 — recoverable per-row failure. `LLMError` codes other
          // than the pool-unsatisfiable case (rate-limit, 5xx, parse
          // error) plus generic source-API / network / producer-code
          // errors all funnel through here. Retry escalation is
          // applied per-row by the caller via `recordProducerFailure`.
          // The reason string is best-effort — `LLMError.code` when
          // available, otherwise the error message.
          const reason =
            e instanceof LLMError
              ? e.code
              : e instanceof Error
                ? e.message
                : String(e);
          return { kind: 'producer_failure', reason };
        }
      };

      // P6 — record a per-row producer failure + log it on the task's
      // ring buffer. Both walk paths share this so the LAP token +
      // `last_errors_json` entry stay consistent. Caller still
      // advances the cursor / continues the loop after this returns;
      // the row's `staleness_class = 'stale'` + LAP `'retry_at_<ts>'`
      // means the next eligible cycle picks it up after backoff.
      const handleProducerFailure = (
        target_id: string,
        reason: string,
        source_record_hash?: string,
      ): void => {
        try {
          ctx.enrichmentStore.recordProducerFailure({
            topic: producer.topic,
            scope: producer.source_scope,
            target_id,
            authored_by,
            reason,
            ...(source_record_hash !== undefined ? { source_record_hash } : {}),
            now: ctx.now(),
          });
        } catch {
          // Storage exception during failure recording is the worst
          // possible time to throw — that would lose the original
          // error context entirely. Best-effort.
        }
        try {
          appendTaskErrorEntry(ctx.db, id, {
            ts: ctx.now(),
            message: `producer_failure: target=${target_id}; ${reason}`,
          });
        } catch { /* best-effort — ring buffer not yet persisted */ }
      };
      const handlePoolUnsatisfiable = (
        layer: 'free' | 'byok' | undefined,
        message: string,
        cursorAfter: TopicCursor,
      ): HousekeepingStepResult => {
        // Best-effort ring-buffer write — `last_errors_json` is only
        // present on persisted state rows, and a task that has never
        // been stepped won't have one yet. The schedule-time persist
        // creates the row before we get here in production; tests that
        // exercise the catch path either pre-seed the row or accept
        // the no-op.
        try {
          appendTaskErrorEntry(ctx.db, id, {
            ts: ctx.now(),
            message: layer !== undefined
              ? `pool_policy_unsatisfiable: forceLayer=${layer}; ${message}`
              : `pool_policy_unsatisfiable: ${message}`,
          });
        } catch { /* best-effort */ }
        return {
          status: 'yield',
          reason: 'pool_policy_unsatisfiable',
          cursor: cursorAfter,
        };
      };

      // ── Stale-row sweep ────────────────────────────────────────
      // Cascade engine flips stale=1 on source mutation; harness
      // re-runs `produce()` against the current source record so the
      // row returns to fresh (or gets deleted via the null-return
      // branch below when state no longer holds). D-145 § A.7.9
      // widened the sweep from `dependent`-only to every policy
      // EXCEPT `independent` so aggregate producers also pick up
      // cross-entity input changes (input changes → cascade marks
      // stale → sweep re-runs produce → null returns → row deleted).
      if (definition.policy !== 'independent') {
        // P6 — eligibility filtered at SQL level so a batch of
        // retry-armed-future / permanently_failed / tombstoned rows
        // ahead of older eligible work doesn't starve the sweep.
        // Codex review of `cb716ca` flagged the prior JS-side filter
        // as a starvation source: 50 ineligible rows would consume
        // the batch every cycle without making progress on truly
        // eligible work behind them.
        // Reuse the cached `start` for the retry-armed-future filter
        // instead of calling `ctx.now()` again — the SQL only compares
        // `retry_at_<ts> <= now` for the per-row backoff window, where
        // sub-second precision against a step-time value is irrelevant
        // (retry windows are seconds / minutes). D-145 § A.7.9: the
        // sweep now runs for every non-`independent` policy, so this
        // call sits on the hot path of aggregate producers too; saving
        // one clock tick keeps the budget-yield contract byte-stable.
        const staleRows = ctx.enrichmentStore.listStaleRowsForReDerive({
          topic: producer.topic,
          scope: producer.source_scope,
          authored_by,
          now: start,
          limit: STALE_SWEEP_BATCH_SIZE,
        });
        for (const row of staleRows) {
          if (checkBudget()) {
            return {
              status: 'yield',
              reason: 'budget_exhausted',
              cursor: { ...topicCursor, max_target_id_seen },
            };
          }
          if (row.target_id == null) continue;
          const sourceRecord = walker.fetchOne(row.target_id);
          if (sourceRecord === null) {
            // Source vanished; the cascade engine's source-delete
            // hook already removed dependents — the stale row
            // shouldn't exist. Defensive delete.
            ctx.enrichmentStore.deleteById(row._id);
            continue;
          }
          // D-161 P2 — input-provenance filter on the sweep path. A row
          // this producer authored passed the forward-walk filter at
          // production time, and source origins are immutable post-genesis,
          // so this fires only when `origin_acceptance` was NARROWED
          // between versions. Delete the producer's own now-orphaned output
          // row rather than skip-and-leave: leaving it would re-fetch +
          // re-skip the same oldest-first batch every cycle and starve
          // accepted stale rows behind it. The SOURCE row stays in the
          // warehouse + reachable — we drop only THIS producer's output,
          // never the source (I-7: treatment, not exclusion); other
          // producers are unaffected.
          if (
            !isOriginActorAccepted(
              readSourceOriginActor(sourceRecord.data),
              originAcceptance,
            )
          ) {
            ctx.enrichmentStore.deleteById(row._id);
            continue;
          }
          const hash = walker.hashOf(sourceRecord);
          const result = await runProduce(sourceRecord);
          if (result.kind === 'pool_unsatisfiable') {
            return handlePoolUnsatisfiable(result.layer, result.message, {
              ...topicCursor,
              max_target_id_seen,
            });
          }
          if (result.kind === 'producer_failure') {
            // P6 — record the failure + advance to the next row.
            // The row's LAP / staleness state is updated by
            // `recordProducerFailure`; the next eligible cycle picks
            // it up after the backoff window opens.
            handleProducerFailure(sourceRecord.target_id, result.reason, hash);
            continue;
          }
          const output = result.output;
          if (output === null) {
            // Producer says "no signal anymore" — drop the row.
            ctx.enrichmentStore.deleteById(row._id);
            continue;
          }
          ctx.enrichmentStore.upsert({
            topic: producer.topic,
            scope: producer.source_scope,
            target_id: sourceRecord.target_id,
            value: output.value,
            authored_by,
            source_record_hash: hash,
            // D-136 P3 — bistemporal + dedup hashes the producer threaded
            // through its output. NULL on any field is acceptable; the
            // store accepts undefined and the legacy non-D-136 producers
            // still land valid rows. Per-record degenerate populates
            // input_fingerprint_hash from the source hash by default.
            ...(output.event_at !== undefined ? { event_at: output.event_at } : {}),
            ...(output.model_id !== undefined ? { model_id: output.model_id } : {}),
            ...(output.ingredient_slug !== undefined
              ? { ingredient_slug: output.ingredient_slug }
              : {}),
            ...(output.producer_version_hash !== undefined
              ? { producer_version_hash: output.producer_version_hash }
              : {}),
            input_fingerprint_hash:
              output.input_fingerprint_hash ?? hash,
            // D-136 P3 — bistemporal `as_of` snapshots producer compute
            // time. Wrapper-based producers (`runAIProducer`) stamp this
            // explicitly; the per-record harness threads `ctx.now()` so
            // both retrofit paths produce consistent metadata.
            as_of: ctx.now(),
            ...(output.sidecar_vector !== undefined
              ? { sidecar_vector: output.sidecar_vector }
              : {}),
            ...(output.sidecar_text !== undefined
              ? { sidecar_text: output.sidecar_text }
              : {}),
          });
        }
      }

      // ── Forward walk ───────────────────────────────────────────
      const seen = new Set<string>();
      while (true) {
        if (checkBudget()) {
          return {
            status: 'yield',
            reason: 'budget_exhausted',
            cursor: { ...topicCursor, max_target_id_seen },
          };
        }

        const batch = Array.from(
          walker.walkAfter(max_target_id_seen, ENRICHMENT_BATCH_SIZE),
        );
        if (batch.length === 0) {
          return {
            status: 'complete',
            cursor: { ...topicCursor, max_target_id_seen },
          };
        }

        for (const record of batch) {
          if (checkBudget()) {
            return {
              status: 'yield',
              reason: 'budget_exhausted',
              cursor: { ...topicCursor, max_target_id_seen },
            };
          }
          // Cursor anti-loop: a malformed walker that never
          // advances past `cursor_token` would otherwise spin.
          // Compare against `max_target_id_seen` after the walk
          // and bail when the batch can't make progress.
          if (seen.has(record.cursor_token)) continue;
          seen.add(record.cursor_token);

          // D-161 P2 — input-provenance filter (the per-producer
          // provenance-filter; distinct from D-132's per-topic trust gate
          // at the scheduler — evaluated independently here, I-8). Skip a
          // source row whose write-actor (`origin_actor`) isn't in this
          // producer's accepted set — *filtered for this producer*, never
          // *excluded from the warehouse* (I-7: the row stays + other
          // producers process it). Undeclared producers fall back to the
          // conservative `user_self` + `system` default, so an attacker-
          // controllable `anonymous` Reception row is never silently fed
          // to an undeclared producer's `ai-extract` (TR-7 / N.9 MUST).
          // Advance the cursor like the no-work skip so the walk
          // progresses past the filtered row.
          if (
            !isOriginActorAccepted(
              readSourceOriginActor(record.data),
              originAcceptance,
            )
          ) {
            max_target_id_seen = record.cursor_token;
            continue;
          }

          const hash = walker.hashOf(record);
          const existing = ctx.enrichmentStore.getByRecord(
            producer.topic,
            producer.source_scope,
            record.target_id,
            authored_by,
          );
          const stale = existing != null && existing.staleness_class !== 'fresh';
          // P6 — skip retry-armed rows whose backoff window hasn't
          // opened yet. Mirrors the stale-sweep gate above. Permanently-
          // failed rows skip too — only manual reset / topic-reset (P7)
          // re-arms them.
          if (existing) {
            const retryAt = parseRetryAtToken(existing.lifecycle_action_pending);
            if (retryAt !== null && retryAt > ctx.now()) {
              max_target_id_seen = record.cursor_token;
              continue;
            }
            if (existing.lifecycle_action_pending === 'permanently_failed') {
              max_target_id_seen = record.cursor_token;
              continue;
            }
          }
          // D-136 P3 — skip rule extends from source-hash-only to also
          // require the existing row's `producer_version_hash` matches
          // the producer's currently-declared hash. When the producer
          // bumps its code+model+prompt+adapter+ingredients fingerprint,
          // existing fresh rows recompute on the next walk even if
          // source content is unchanged. Producers that haven't
          // retrofitted (no `producer.producer_version_hash`) skip on
          // source-hash-only — backward-compat, no behavior change.
          //
          // D-145 § A.7.8 (Amended 2026-05-26): callable
          // producer_version_hash. Producers with user-tunable params
          // declare a `(ctx) => string` that folds the topic's current
          // `tunable_params_hash` into the composition; the harness
          // resolves per-cycle so a tune invalidates rows on the next
          // walk even when source content is unchanged.
          const resolvedProducerVersionHash =
            typeof producer.producer_version_hash === 'function'
              ? producer.producer_version_hash(ctx)
              : producer.producer_version_hash;
          const versionHashMatches =
            resolvedProducerVersionHash === undefined ||
            (existing != null &&
              existing.producer_version_hash === resolvedProducerVersionHash);
          if (
            existing &&
            !stale &&
            existing.source_record_hash === hash &&
            versionHashMatches
          ) {
            // No-work skip — source hash unchanged + producer version
            // matches (or producer pre-D-136-P3, no version declared).
            max_target_id_seen = record.cursor_token;
            continue;
          }
          const result = await runProduce(record);
          if (result.kind === 'pool_unsatisfiable') {
            return handlePoolUnsatisfiable(result.layer, result.message, {
              ...topicCursor,
              max_target_id_seen,
            });
          }
          if (result.kind === 'producer_failure') {
            // P6 — record + advance. The placeholder INSERT path inside
            // `recordProducerFailure` covers the brand-new-record case
            // where no row existed yet; UPDATE path covers the retry
            // case where a prior failure left a stale row.
            handleProducerFailure(record.target_id, result.reason, hash);
            max_target_id_seen = record.cursor_token;
            continue;
          }
          const output = result.output;
          if (output !== null) {
            ctx.enrichmentStore.upsert({
              topic: producer.topic,
              scope: producer.source_scope,
              target_id: record.target_id,
              value: output.value,
              authored_by,
              source_record_hash: hash,
              // D-136 P3 — bistemporal + dedup hashes from producer output.
              ...(output.event_at !== undefined ? { event_at: output.event_at } : {}),
              ...(output.model_id !== undefined ? { model_id: output.model_id } : {}),
              ...(output.ingredient_slug !== undefined
                ? { ingredient_slug: output.ingredient_slug }
                : {}),
              ...(output.producer_version_hash !== undefined
                ? { producer_version_hash: output.producer_version_hash }
                : {}),
              input_fingerprint_hash:
                output.input_fingerprint_hash ?? hash,
              // D-136 P3 — bistemporal `as_of` snapshots producer compute
              // time, mirroring `runAIProducer`'s wrapper-side stamp so
              // both retrofit paths produce consistent metadata.
              as_of: ctx.now(),
              ...(output.sidecar_vector !== undefined
                ? { sidecar_vector: output.sidecar_vector }
                : {}),
              ...(output.sidecar_text !== undefined
                ? { sidecar_text: output.sidecar_text }
                : {}),
            });
          } else if (existing) {
            // D-145 § A.7.9 — produce() returned null after previously
            // emitting; the source state no longer satisfies the
            // producer's conditions. Drop the row so consumers don't
            // read a stale snapshot. First-walk null (no existing row)
            // continues to no-op silently.
            ctx.enrichmentStore.deleteById(existing._id);
          }
          max_target_id_seen = record.cursor_token;
        }

        // Walker returned a non-empty batch smaller than the
        // requested size — assume the source is exhausted.
        if (batch.length < ENRICHMENT_BATCH_SIZE) {
          return {
            status: 'complete',
            cursor: { ...topicCursor, max_target_id_seen },
          };
        }
      }
    },

    onInvalidate(ctx: HousekeepingContext, hint: HousekeepingInvalidateHint): void {
      // P4 keeps onInvalidate as a status-only nudge: the eager
      // cascade engine has already marked dependent rows stale
      // (D-122 P4.5), and the next stale-sweep walk handles
      // re-derivation. Resetting the forward-walk cursor here
      // would force a no-work re-walk that the skip-rule
      // immediately discards — wasted budget without correctness
      // benefit.
      //
      // What we DO here: nothing. The hook exists so the
      // cascade-invalidation wiring (P6) has a place to call
      // through; the actual work lives in the stale-sweep above.
      void ctx;
      void hint;
    },
  };
};

/** Suppress dead-code warning on the cadence helper export — the
 *  scheduler integration that consumes it lands in a later D. */
export const HOUSEKEEPING_DEFAULT_BATCH_SIZE = ENRICHMENT_BATCH_SIZE;
export const HOUSEKEEPING_STALE_SWEEP_BATCH_SIZE = STALE_SWEEP_BATCH_SIZE;
export const HOUSEKEEPING_MIN_BUDGET_MS = HOUSEKEEPING_MIN_TASK_BUDGET_MS;
