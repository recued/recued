/** D-136 §A.3 — `runAIProducer` wrapper.
 *
 *  Single dedup-discipline pipeline for AI-surface housekeeping
 *  producers that own their own walk (`lifecycle_stage_inferred*` /
 *  `topic_cluster` / `company` / `role` etc. — anything not riding
 *  the `enrichment-producer.ts` per-record harness). Order:
 *
 *    1. Compute `input_fingerprint_hash` from the producer's declared
 *       composition kind (per-record degenerates to source_record_hash).
 *    2. Probe the dedup index `(target_id, input_fingerprint_hash,
 *       producer_version_hash)` — if a fresh row matches, return
 *       `'dedup_hit'` with zero token cost.
 *    3. Trust gate (D-132) — if `enrichment_trust` flips the topic
 *       to `'off'`, return `'skipped_trust'`.
 *    4. LLM call via `ctx.llmWithMeta` (resolves model_id at call time).
 *    5. Upsert with full bistemporal stamping — `event_at` from the
 *       producer's source-derived clock (NOT `ctx.now()`),
 *       `as_of`/`last_evaluated_at` from `ctx.now()`, plus the
 *       fingerprint + version hashes + model_id.
 *
 *  Per-record producers riding the per-record-walk harness in
 *  `enrichment-producer.ts` use the harness's existing
 *  `source_record_hash`-driven skip rule and don't need this
 *  wrapper directly — the harness threads `event_at` /
 *  `producer_version_hash` / `model_id` / `input_fingerprint_hash`
 *  through `runAIProducer`-equivalent fields on the per-record
 *  output (see `EnrichmentProducerOutput.event_at` etc.).
 *
 *  Audit §27 — the wrapper makes steady-state cycles zero-cost for
 *  unchanged records: PII salt rotation no longer matters because
 *  `source_record_hash` (and therefore `input_fingerprint_hash`
 *  for the per-record degenerate) is computed BEFORE PII
 *  replacement, so unchanged source content always hits dedup.
 *
 *  Spec: `docs/d-136-spec.md` §A.3. */

import {
  computeInputFingerprintHash,
  type EnrichmentScope,
  type EnrichmentTopic,
  type IngredientManifest,
  type InputFingerprintHashInput,
} from '@recued/contracts';

import type { HousekeepingContext } from './registry.js';
import {
  isByokAllowedForBackground,
  type TrustStore,
} from './trust-store.js';
import {
  composeEnrichmentPath,
  hashEnrichmentResult,
  hashLlmInput,
  parseEnrichmentPath,
  readEnrichmentValueFromPath,
} from './llm-result-cache-store.js';
import { wrapHousekeepingCtxForRecord } from './enrichment-pii-egress.js';

/** Source-derived event-time signals the wrapper needs to stamp the
 *  bistemporal `event_at` correctly per D-120 P7.5 + audit §20.2 fix.
 *  Producers compose this from their source record (mail `Date:`
 *  header, calendar `start.dateTime`, file `mtime`, platform-record
 *  `meta.snapshot_at` etc.) — when null/undefined, the wrapper falls
 *  back to `ctx.now()` and a runtime warning fires once per cycle so
 *  the gap is visible in the per-task error ring buffer. */
export interface AIProducerEventClock {
  /** Source's real-world event time. The bistemporal-correct value
   *  for `event_at` per D-120 P7.5 + audit §20.2 fix. */
  event_at: number | null;
}

/** Closed-list status discriminator returned from `runAIProducer`. */
export type AIProducerOutcome<T> =
  | {
      status: 'computed';
      rows_written: number;
      tokens_consumed: number;
      ai_result: T;
      model_id: string;
      /** D-145 § A.7.10 — true when the LLM call was skipped because
       *  the content-addressed cache resolved the input to a prior
       *  result. `tokens_consumed === 0` on cache hit (no model call
       *  was made). Producers can branch on this for hit-rate
       *  telemetry. Defaults to `false` for legacy callers + cache-
       *  unaware producers. */
      cached: boolean;
      /** D-145 § A.7.10 — set only when `cached === true`: the
       *  enrichment-path that supplied the cached value. */
      cached_from_path?: string;
    }
  | {
      status: 'dedup_hit';
      rows_written: 0;
      tokens_consumed: 0;
    }
  | {
      status: 'skipped_trust';
      rows_written: 0;
      tokens_consumed: 0;
    };

/** Inputs to `runAIProducer`. Producers compose this struct per
 *  per-record/per-target call. The wrapper handles dedup probe + trust
 *  gate + LLM call + upsert; producers stay focused on prompt
 *  composition + output validation + value-shape assembly.
 *
 *  Per-record producers may omit `inputFingerprint`'s aggregate /
 *  perspective / upstream-chain shape and pass
 *  `{ kind: 'per_record_source_hash', source_record_hash }` directly
 *  (the wrapper degenerates to the source hash). Aggregate /
 *  perspective / upstream-consuming producers MUST pass the explicit
 *  composition shape — registry validator gate 8 (D-136 P1) requires
 *  these topics declare `inputFingerprintComposition` and the
 *  contract is enforced at call time here. */
export interface RunAIProducerInput<TAi, TValue> {
  ctx: HousekeepingContext;
  topic: EnrichmentTopic;
  /** Shape A targets carry both. Shape B (derived_entity) producers
   *  pass `derived_entity_id` instead — the wrapper's upsert path
   *  handles either via `EnrichmentUpsertInput`. */
  scope?: EnrichmentScope;
  target_id?: string;
  derived_entity_id?: string;
  /** Stamped on the enrichment row. Producers compose via
   *  `enrichmentProducerAuthoredBy(topic)` from `enrichment-producer.ts`. */
  authored_by: string;
  /** Per-record `source_record_hash` — passed through to the row's
   *  `source_record_hash` column. Always populated; producers that
   *  aggregate set this to a stable hash of the primary anchor row
   *  (the dedup primary is `input_fingerprint_hash` in those cases,
   *  but `source_record_hash` still flows for cross-cycle skip rules). */
  source_record_hash: string;
  /** Composition input for `computeInputFingerprintHash`. Closed-list
   *  discriminator per spec §A.3. */
  inputFingerprint: InputFingerprintHashInput;
  /** Producer's current code+model+prompt+adapter+ingredients
   *  fingerprint per `computeProducerVersionHash` — bumps on
   *  producer revisions. Wrapper forwards verbatim to the upsert. */
  producer_version_hash: string;
  /** Ingredient slug (`'ai-classify'`, `'ai-extract'`, etc.) the
   *  producer's LLM call uses. Stamped on the row in `ingredient_slug`. */
  ingredient_slug: string;
  /** Bistemporal stamping. `event_at` is the source's own clock
   *  (NOT `ctx.now()` — audit §20.2). NULL is acceptable for
   *  derived-entity / aggregate producers without a single source
   *  clock; the wrapper falls back to `ctx.now()` + emits a one-time
   *  warning per cycle. */
  eventClock: AIProducerEventClock;
  /** AI manifest the wrapper passes to `ctx.llmWithMeta`. */
  manifest: IngredientManifest;
  /** Input map for the LLM call. Wrapper passes it verbatim. */
  llmInput: Record<string, unknown>;
  /** D-167 — structured source record that seeds the per-record PII
   *  alias ledger. When provided alongside `scope`, the wrapper routes
   *  the (cache-miss) LLM call through `wrapHousekeepingCtxForRecord`:
   *  PII seeded from this record's `MetaField.privacy`-tagged structured
   *  fields is aliased in the `llm.data` blob on egress and restored on
   *  the model output before `validate` / `buildValue` see it — the same
   *  comfort-layer guarantee the per-record harness (`runProduce`) gives
   *  its producers, now extended to the own-walk `runAIProducer` callers.
   *
   *  Pass the structured record whose fields were flattened into
   *  `llm.data` (e.g. the contact signal bundle whose `email` appears in
   *  the classification prompt). Seed from the EGRESSED values — if the
   *  prompt carries a canonicalised email, seed the canonicalised form so
   *  the content-scan matches.
   *
   *  Omit it (or omit `scope`, or wire no tag source / privacy schema) and
   *  the LLM call is byte-identical to pre-D-167 — the no-op default. This
   *  is the correct posture for fan-in producers (aggregate window folds,
   *  cluster labelling) that have no single structured seed record: their
   *  egressing PII lives across many evidence rows under a different scope,
   *  which needs a distinct multi-record seeding pass (a documented
   *  follow-on, not covered by this single-record seam). */
  sourceRecordData?: unknown;
  /** Validate the AI result. Throws when shape is malformed; the
   *  wrapper re-throws so the per-task error counter trips. */
  validate: (raw: unknown) => TAi;
  /** Compose the persisted enrichment value from the validated AI
   *  result. */
  buildValue: (ai_result: TAi) => TValue;
  /** Optional sidecar payloads (vector / fts) keyed off the
   *  topic's `sidecar` declaration in the registry. */
  sidecar_vector?: Buffer;
  sidecar_text?: string;
  /** D-128 — meta snapshot for platform-reference scopes
   *  (`connection.api.<vendor>.<entity>`). Producers writing to
   *  platform scopes pass the canonical-fields snapshot. */
  meta?: import('@recued/contracts').EnrichmentMeta;
  /** Pre-flight token estimate, surfaced when `'computed'` outcome
   *  fires. Producers tend to pass their existing
   *  `*_TOKEN_ESTIMATE` constant. */
  token_estimate?: number;
  /** D-132 — trust store for the gate. Producers that already gated
   *  via `effectiveLayer === 'free' && !ctx.trustStore?.read(...)`
   *  may pass `undefined` to skip the gate; the wrapper defaults to
   *  consulting `ctx.trustStore`. */
  trustStore?: TrustStore;
  /** D-145 § A.7.10 — opt-in for the content-addressed LLM result
   *  cache. Returns the literal bytes the wrapper hashes for the cache
   *  key — typically `{ system_prompt, user_message, output_schema }`
   *  drawn straight from `llmInput`. When undefined, the wrapper
   *  bypasses cache lookups + cache writes (cache-miss path on every
   *  call). When set, producers MUST keep the composition target-
   *  agnostic + buildValue idempotent-under-same-input — same input
   *  → same persisted value, no per-target metadata mixed in. Cache
   *  reuse breaks for producers that mix target-specific fields into
   *  `buildValue`; those simply don't pass `compose_input`. */
  compose_input?: () => unknown;
}

/** Single dedup-+-trust-+-LLM-+-upsert pipeline. Returns the outcome
 *  discriminator + per-call counters so callers can update task-level
 *  stats (`produced += rows_written`, `tokens_total += tokens_consumed`).
 *
 *  Throws when:
 *    - `ctx.llmWithMeta` is unwired (producer misconfiguration).
 *    - `validate` rejects the AI output.
 *    - Upsert fails (storage shape / scope mismatch).
 *    - LLM call propagates its own `LLMError`.
 *
 *  Does NOT throw when the dedup probe matches or the trust gate
 *  closes — those are first-class outcomes, not errors. */
export const runAIProducer = async <TAi, TValue>(
  input: RunAIProducerInput<TAi, TValue>,
): Promise<AIProducerOutcome<TAi>> => {
  const { ctx, topic } = input;

  if (!ctx.llmWithMeta) {
    throw new Error(
      `runAIProducer_misconfigured: ctx.llmWithMeta is required for topic '${topic}'`,
    );
  }
  // Captured post-guard (non-undefined) so it can backstop the D-167
  // alias-seam wrap below — the wrapped ctx preserves `llmWithMeta` iff
  // the base ctx had it, but TS doesn't carry the narrowing onto the new
  // object, so the `??` fallback keeps the call type-safe.
  const baseLlmWithMeta = ctx.llmWithMeta;

  // 1. Dedup probe — input_fingerprint_hash + producer_version_hash + model_id.
  // The probe folds the would-be resolved model id into the match
  // condition: when no probe is wired (legacy ctx), we fall back to
  // matching on (input_fingerprint_hash, producer_version_hash) only.
  // When the probe succeeds, cross-pool changes (free-pool ↔ BYOK)
  // invalidate the cached row because the existing row's `model_id`
  // column reflects the model that actually computed the value, while
  // the probe returns what the next call WOULD pick.
  const input_fingerprint_hash = computeInputFingerprintHash(input.inputFingerprint);
  const probedModelId = ctx.resolveLLMModelId
    ? await ctx.resolveLLMModelId(input.manifest, input.llmInput)
    : '';

  if (input.scope !== undefined && input.target_id !== undefined) {
    const existing = ctx.enrichmentStore.list({
      topic,
      scope: input.scope,
      target_id: input.target_id,
      authored_by: input.authored_by,
      fresh_only: true,
      limit: 1,
    });
    const hit = existing.find(
      (r) =>
        r.input_fingerprint_hash === input_fingerprint_hash &&
        r.producer_version_hash === input.producer_version_hash &&
        // Cross-pool invalidation: when the probe is wired AND it
        // returned a model id (i.e. an AI path resolves), require the
        // existing row's `model_id` to match. When the probe is not
        // wired or returned empty, fall through to legacy behavior so
        // tests and pre-D-136 ctx instances keep working unchanged.
        (probedModelId === '' || r.model_id === probedModelId),
    );
    if (hit) {
      // Refresh `last_evaluated_at` so the row's "we checked recently"
      // signal moves forward even on a no-token cycle. The store
      // auto-stamps `last_evaluated_at = now()` on every upsert — we
      // don't redo the upsert here because a redundant write defeats
      // the dedup purpose; future P5 cascade work may add a touch-only
      // path.
      return { status: 'dedup_hit', rows_written: 0, tokens_consumed: 0 };
    }
  }

  // 2. Trust gate (D-132). The topic's `enrichment_trust` row decides
  // whether background AI fires. Pause-AI window + global
  // `allow_byok_background = false` collapse this gate too. The
  // existing per-record harness already gates at the schedule level
  // (idle-cycle eligibility); custom-cycle producers using this
  // wrapper layer the same gate at call time so a Run-Now bypass
  // behaves consistently.
  const trustStore = input.trustStore ?? ctx.trustStore;
  if (trustStore !== undefined) {
    const trust = trustStore.read(topic, true);
    if (trust.trust_state === 'off') {
      return { status: 'skipped_trust', rows_written: 0, tokens_consumed: 0 };
    }
  }

  // 3. LLM result cache lookup (D-145 § A.7.10). Opt-in via
  // `compose_input` — when the producer declares which bytes drive its
  // LLM call, the wrapper hashes them, looks up the cache, and (on
  // hit) reuses the previously-computed value instead of re-calling
  // the model. Spec invariant 7: cache fires AFTER the dedup probe so
  // (source_record_hash, producer_version_hash) skip-rule still wins.
  let inputHashForCache: string | undefined;
  let cached_value: unknown | undefined;
  let cached_model_id: string | undefined;
  let cached_from_path: string | undefined;
  if (input.compose_input !== undefined && ctx.llmResultCache !== undefined) {
    inputHashForCache = hashLlmInput(input.compose_input());
    const entry = ctx.llmResultCache.lookup(inputHashForCache);
    if (entry !== null) {
      const probedValue = readEnrichmentValueFromPath(ctx.enrichmentStore, entry.result_path);
      if (probedValue === null) {
        // Dangling cache entry — the target row was deleted (§ A.7.9
        // universal cleanup fired). Lazy GC + fall through.
        ctx.llmResultCache.delete(inputHashForCache);
      } else {
        const probedHash = hashEnrichmentResult(probedValue);
        if (probedHash !== entry.result_hash) {
          // Hash drifted — external mutation / corruption. Defensive
          // lazy delete + fall through to LLM. NOT an AI-non-
          // determinism case: identical input via cache always returns
          // the cached path, so the cache path itself can't drift.
          ctx.llmResultCache.delete(inputHashForCache);
        } else {
          // Confirmed hit. Pull model_id off the source row too so the
          // current target's row stamps the model that actually
          // produced the value.
          cached_value = probedValue;
          cached_from_path = entry.result_path;
          cached_model_id = readEnrichmentModelIdFromPath(
            ctx.enrichmentStore,
            entry.result_path,
          );
          ctx.llmResultCache.incrementHitCount(inputHashForCache);
        }
      }
    }
  }

  // 4. LLM call — captures `model_id` at call time so the row's
  // `model_id` column reflects the cross-pool resolution decision
  // (audit §20.2). Validation throws on shape failure. Cache hits
  // short-circuit this step; `ai_result` is materialized from the
  // cached value via `input.validate` so opt-in producers stay
  // consistent with the cache-miss path (validate is required to
  // produce a typed result; the cache's hash guarantee makes
  // re-validation cheap insurance).
  let result_for_outcome: TAi;
  let model_id_for_row: string;
  let value: ReturnType<typeof input.buildValue>;
  if (cached_value !== undefined) {
    result_for_outcome = input.validate(cached_value);
    value = input.buildValue(result_for_outcome);
    model_id_for_row = cached_model_id ?? '';
  } else {
    // D-167 — non-chat AI-egress PII aliasing. When the caller supplies a
    // structured source record (+ scope), route this LLM call through the
    // per-record alias seam so known PII in `llm.data` is aliased on egress
    // and restored on the model output before `validate` / `buildValue`
    // parse it. A no-op (returns the raw ctx) when no seed record / scope /
    // tag source / privacy tags resolve — byte-identical to pre-D-167. The
    // wrap is LAZY (only on the actual model call) so the dedup-probe and
    // cache-hit short-circuits above pay nothing for steady-state cycles.
    const llmCtx =
      input.scope !== undefined && input.sourceRecordData !== undefined
        ? wrapHousekeepingCtxForRecord(ctx, input.scope, input.sourceRecordData)
        : ctx;
    const llmCall = await (llmCtx.llmWithMeta ?? baseLlmWithMeta)(
      input.manifest,
      input.llmInput,
    );
    result_for_outcome = input.validate(llmCall.result);
    value = input.buildValue(result_for_outcome);
    model_id_for_row = llmCall.model_id;
  }

  // 5. Upsert with full bistemporal stamping. `event_at` flows from
  // the source's own clock per D-120 P7.5; `as_of` /
  // `last_evaluated_at` are the producer's compute time.
  const now = ctx.now();
  const event_at = input.eventClock.event_at ?? now;

  ctx.enrichmentStore.upsert({
    topic,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.target_id !== undefined ? { target_id: input.target_id } : {}),
    ...(input.derived_entity_id !== undefined
      ? { derived_entity_id: input.derived_entity_id }
      : {}),
    value,
    authored_by: input.authored_by,
    source_record_hash: input.source_record_hash,
    ingredient_slug: input.ingredient_slug,
    model_id: model_id_for_row,
    event_at,
    as_of: now,
    producer_version_hash: input.producer_version_hash,
    input_fingerprint_hash,
    ...(input.sidecar_vector !== undefined ? { sidecar_vector: input.sidecar_vector } : {}),
    ...(input.sidecar_text !== undefined ? { sidecar_text: input.sidecar_text } : {}),
    ...(input.meta !== undefined ? { meta: input.meta } : {}),
  });

  // 6. Cache insert (D-145 § A.7.10). Only on cache miss; first-
  // writer-wins (insert-or-ignore) so concurrent producers reaching
  // the same input don't fight. The pointer references the row this
  // producer just wrote — readers verify the value at that path
  // against `result_hash` on every subsequent hit.
  if (
    cached_value === undefined &&
    inputHashForCache !== undefined &&
    ctx.llmResultCache !== undefined
  ) {
    const result_path =
      input.derived_entity_id !== undefined
        ? composeEnrichmentPath({ topic, derived_entity_id: input.derived_entity_id })
        : input.scope !== undefined && input.target_id !== undefined
          ? composeEnrichmentPath({ topic, scope: input.scope, target_id: input.target_id })
          : null;
    if (result_path !== null) {
      ctx.llmResultCache.insertOrIgnore({
        input_hash: inputHashForCache,
        result_hash: hashEnrichmentResult(value),
        result_path,
        computed_at: now,
      });
    }
  }

  const cached = cached_value !== undefined;
  return {
    status: 'computed',
    rows_written: 1,
    tokens_consumed: cached ? 0 : (input.token_estimate ?? 0),
    ai_result: result_for_outcome,
    model_id: model_id_for_row,
    cached,
    ...(cached_from_path !== undefined ? { cached_from_path } : {}),
  };
};

/** Read the persisted `model_id` at an enrichment path. Used on cache
 *  hit so the current target's row stamps the model that actually
 *  produced the cached value. Returns `undefined` when the path is
 *  unresolvable (caller treats as empty model_id). */
const readEnrichmentModelIdFromPath = (
  enrichmentStore: import('../storage/enrichment-store.js').EnrichmentStore,
  path: string,
): string | undefined => {
  const parsed = parseEnrichmentPath(path);
  if (!parsed) return undefined;
  if (parsed.kind === 'shape_b') {
    const row = enrichmentStore.getDerived(parsed.topic, parsed.derived_entity_id);
    return row?.model_id ?? undefined;
  }
  const rows = enrichmentStore.list({
    topic: parsed.topic,
    scope: parsed.scope,
    target_id: parsed.target_id,
    fresh_only: true,
  });
  return rows[0]?.model_id ?? undefined;
};
