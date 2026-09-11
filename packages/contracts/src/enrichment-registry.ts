/** D-122 Phase 4.5 — Enrichment substrate registry.
 *
 *  One unified `data.enrichment.*` namespace, one storage table, one
 *  generic upsert-by-topic ingredient. Topic membership lives in the
 *  static registry below — adding topic 100 is a registry entry plus
 *  (eventually) a producer; the kernel ingredient surface and the
 *  storage schema don't widen.
 *
 *  Two row shapes coexist via NULL-aware unique indexes on the storage
 *  table:
 *
 *    - Shape A — per-record fact. `scope` is one of
 *      `'mail' | 'contact' | 'calendar' | 'file'`; `target_id` keys the
 *      record the fact hangs off. `_id` is `enr_<ulid>` (auto). The
 *      registry's `valid_scopes` constrains which collections can carry
 *      the topic; `policy` controls how cascade fires when the source
 *      record changes.
 *
 *    - Shape B — derived entity. `scope` and `target_id` are NULL; `_id`
 *      is the entity id chosen by the producer (e.g.
 *      `topic_cluster_<hash>`). The row IS the entity; recipe refs
 *      address it as `data.enrichment.<topic>.<id>`.
 *
 *  Three reactive producers ship in D-122 (`contact_timeline_rollup`,
 *  `calendar_event_rollup`, `meeting_reschedule_pattern`) — they back
 *  the alert-recipe pack and fold new events as they arrive (Model A).
 *  The remaining topics are reserved IDs only — D-123 ships the
 *  housekeeping execution mode + canary `thread_signals` producer;
 *  subsequent Ds add the rest one at a time on the same harness.
 *
 *  The codebase doesn't use Zod (intentionally — `@recued/contracts`
 *  is dep-free), so `value_schema` is a lightweight TS validator
 *  returning `{ ok, value, issues }` per entry. Same shape Zod would
 *  hand back; the producer-side wiring is unchanged when later
 *  housekeeping producers swap some entries to Zod schemas.
 *
 *  Spec: D-122 §"Enrichment substrate". */

// ────────────────────────────────────────────────────────────────
// Cross-module imports
// ────────────────────────────────────────────────────────────────
//
// D-139 P3 — `last_meaningful_touch` value-shape uses the closed-list
// `Authorship` + `Direction` enums declared in
// `engagement-evidence.ts`. The validator narrows the substrate-side
// evidence-quality types into the producer's per-touch projection.

import {
  AUTHORSHIP_SET,
  AUTHORSHIP_VALUES,
  BODY_STATE_SET,
  BODY_STATE_VALUES,
  DEDUPE_ACCEPTANCE_SET,
  DEDUPE_ACCEPTANCE_VALUES,
  DIRECTION_SET,
  ENGAGEMENT_LIFECYCLE_STATE_SET,
  ENGAGEMENT_LIFECYCLE_STATE_VALUES,
  isSourceDegradationReason,
  type Authorship,
  type BodyState,
  type DedupeAcceptance,
  type Direction,
  type EngagementLifecycleState,
  type SourceDegradationReason,
} from './engagement-evidence.js';
// D-161 P2 — producer provenance-filter declares the `origin_actor`
// classes a producer accepts as input (input-provenance trust axis).
import type { Actor } from './commits.js';
// Work-entity scopes are DERIVED from the kind union, never re-spelled
// — `work-entities.ts` is a leaf module (zero imports), so this
// direction can never cycle.
import { WORK_ENTITY_KINDS, type WorkEntityKind } from './work-entities.js';

// ────────────────────────────────────────────────────────────────
// Type system
// ────────────────────────────────────────────────────────────────

export type EnrichmentShape = 'per_record' | 'derived_entity';

/** Cascade-policy presets. The `policy` field doubles as the
 *  housekeeping execution shape — D-123's cursor-driven engine reads
 *  `policy` to dispatch the right loop. */
export type EnrichmentPolicy =
  | 'dependent'        // 1:1 with a source record; cascade-deletes on source delete; cascade-marks-stale on source update; harness re-derives or deletes on null
  | 'members_list'     // owns a list of source-record ids; cascade trims members on source delete (drops row when list empties); harness re-derives or deletes on null
  | 'aggregate'        // folds many source rows into one row; cascade-deletes on source delete (D-145 § A.7.9); harness re-derives or deletes on null
  | 'independent';     // no source linkage; cascade is a no-op; harness never deletes (producer owns row lifecycle)

/** Source-collection scope for Shape A topics.
 *
 *  Three families share one column:
 *    - `data.*` collections: `'mail' | 'contact' | 'calendar' | 'file'`.
 *      Composed by `composeEnrichmentScope('data', '<collection>')` →
 *      bare collection name.
 *    - `connection.*` records (D-125 P6.1): `'connection.api' |
 *      'connection.mcp' | 'connection.notification'`. Composed by
 *      `composeEnrichmentScope('connection', '<kind>')` → dotted form.
 *      Connection-scope enrichments key on `target_id = <connection name>`
 *      (e.g. `'hubspot'`) — same shape-A row layout, no SQL migration.
 *    - **Platform-reference scopes (D-128):** `'connection.api.<vendor>.<entity>'`
 *      — four-segment shape for records that live on platforms the user
 *      does not mirror locally (HubSpot deals, Salesforce opportunities, …).
 *      Composed by `composeVendorEntityScope(vendor, entity)`. The vendor
 *      owns the record; Recued attaches enrichments by reference via the
 *      platform-native `target_id`. Substrate is vendor-agnostic at D-128
 *      — vendor Ds (D-129 HubSpot, D-130 Salesforce) populate the
 *      vendor-entity registry. */
export type EnrichmentScope =
  | 'mail'
  | 'contact'
  | 'calendar'
  | 'file'
  // ── D-145 PA4: canonical work-entity scopes ────────────────────
  // Producers ship in PA9 (`commitment_followthrough_score`,
  // `task_completion_velocity`, `project_velocity`, etc.); the cascade
  // engine wiring lands in PA4 so writes against the work entities
  // invalidate downstream rows the moment the producers register.
  // ⚠ DERIVED — this was one of THREE hand-copies of the kind list in
  // this file alone (the union arms, `ALL_ENRICHMENT_SCOPES`, and
  // `WORK_ENTITY_ENRICHMENT_SCOPES`, the last being literally the kind
  // list under another name). A new kind silently got no scope.
  | WorkEntityKind
  | 'connection.api'
  | 'connection.mcp'
  | 'connection.notification'
  // ── D-128: platform-reference scopes ───────────────────────────
  | `connection.api.${string}.${string}`;

/** D-125 P6.1 — closed list of namespaces that participate in
 *  enrichment scope composition. `data` produces bare-collection scopes;
 *  `connection` produces dotted `connection.<kind>` scopes. */
export type EnrichmentNamespace = 'data' | 'connection';

/** Optional sidecar attached via FK CASCADE. `vector_index` for embedding
 *  topics, `fts` for searchable text topics (summaries). `none` is the
 *  default — most topics need neither. */
export type EnrichmentSidecar = 'none' | 'vector_index' | 'fts';

/** Producer-kind discriminator. Governs Settings → Housekeeping UI:
 *  - `'reactive'`     → "live, N events processed", no manual-start
 *  - `'housekeeping'` → progress + permission + stats + "Run now" + token-cost preview
 *
 *  D-122 ships three reactive producers; D-123 ships the housekeeping
 *  execution mode + canary `thread_signals` producer; the remaining
 *  16 housekeeping topics ship one-at-a-time in subsequent Ds on the
 *  same harness. */
export type EnrichmentProducerKind = 'reactive' | 'housekeeping';

/** Recompute cadence for `aggregate` topics — drift correction window.
 *  `'never'` means the producer is fully incremental and never needs a
 *  full re-pass (rare; only for topics whose value is provably
 *  deterministic from the cursor). */
export type EnrichmentRecomputeCadence = '6h' | '24h' | '7d' | 'never';

// ────────────────────────────────────────────────────────────────
// D-136 — Enrichment lifecycle & temporal substrate
// ────────────────────────────────────────────────────────────────

/** D-136 §A.1 — what kind of fact a topic captures.
 *
 *  - `'stable_truth'` — fact frozen at event time (model improvement
 *    can produce a different answer; PSI drift is meaningful;
 *    `recompute_on_drift` is honest).
 *  - `'time_bound'` — captures moving-entity state at `as_of`
 *    (regen against `now` overwrites historical truth and corrupts
 *    the trajectory; `recompute_on_drift` is forbidden).
 *  - `'aggregate_window'` — function of `(as_of, window)` over many
 *    source rows (replayable iff sources are time-travelable —
 *    `audit` and `data_enrichment` only). */
export type TemporalClass = 'stable_truth' | 'time_bound' | 'aggregate_window';

/** D-136 §A.1 — what kind of identity the row keys on.
 *
 *  - `'scenario'` — per-instance, bound to a specific record context
 *    (mail / calendar event / connection record / platform-reference
 *    entity). Cascade fans out per source record.
 *  - `'perspective'` — cross-instance, aggregated to a canonical
 *    identity (a contact, a working group, an organization). Cascade
 *    needs the perspective fan-in (cascadeForIdentityChange) to
 *    invalidate when any contributing source updates. */
export type IdentityAggregation = 'scenario' | 'perspective';

/** D-136 §A.2 — lifecycle policy.
 *
 *  - `'forward_only'` — overwrite-in-place on cascade; no historical
 *    chain; no time-travel reads. The default for aggregate topics
 *    folding from non-time-travelable sources.
 *  - `'ttl'` — discard after `ttl_days` post-`event_at`;
 *    tombstone-with-id preserves D-120 link graph.
 *  - `'recompute_on_drift'` — regen when PSI fires (only valid for
 *    `stable_truth`, OR `aggregate_window` whose `aggregates_from` is
 *    fully time-travelable).
 *  - `'historical'` — append-with-supersede; preserve trajectory via
 *    the `superseded_by_id` chain. The right policy for time_bound
 *    topics whose history is the signal.
 *  - `'manual_pinned'` — runtime-only; populated by user-correction
 *    votes (§A.11). Validator rejects this on registry registration —
 *    set per-row at vote time, not at topic-definition time. */
export type LifecyclePolicy =
  | 'forward_only'
  | 'ttl'
  | 'recompute_on_drift'
  | 'historical'
  | 'manual_pinned';

/** D-136 §A.1 — for `aggregate_window` topics, which clock anchors
 *  the trailing window.
 *
 *  - `'event_time'` — window slides on the source event's own clock
 *    (mail Date: header, calendar event start). The right axis when
 *    the user's actual interaction cadence is what matters
 *    (e.g. `behavioral_signature`).
 *  - `'ingestion_time'` — window slides on warehouse write time. The
 *    right axis when "the recent N days of OUR observations" is what
 *    the topic measures (e.g. `connection_health_trend`). */
export type AggregateWindowAxis = 'event_time' | 'ingestion_time';

/** D-136 §A.5 — extracts the canonical identity key(s) from a source
 *  record. Used by `cascadeForIdentityChange` to fan in to perspective
 *  topics when any contributing source updates. P1 ships sentinel
 *  values; P5 wires them into the cascade engine. */
export type IdentityExtractor = (record: unknown) => string | string[];

/** D-136 §A.3 — composes the input-set hash for a single
 *  `(producer, topic, target)` row. Per-record producers may omit
 *  this (degenerates to `source_record_hash`); aggregate / perspective /
 *  upstream-consuming producers MUST implement it (validator gate at
 *  registration). The composition folds in: sorted source_record_hashes,
 *  upstream enrichment_row_ids, as_of, window_ms, effective topic
 *  config — anything that materially changes "what this answer is."
 *  P1 ships the type only; P3 retrofits producers. */
export type InputFingerprintComposition = 'per_record_source_hash' | 'aggregate_window_fold' | 'perspective_fan_in' | 'upstream_chain';

/** D-136 §A.9 — kernel `enrichment-upsert` ingredient writer mode.
 *
 *  - `'overwrite'` — replace the chain head in place. Default for
 *    every non-`'historical'` lifecycle policy. Rejected at the upsert
 *    handler when the topic's `lifecycle_policy === 'historical'`
 *    (must be explicit `'supersede'` or refuse).
 *  - `'supersede'` — append a new chain head + flip the prior head's
 *    `superseded_by_id` forward. Default when the topic's
 *    `lifecycle_policy === 'historical'`. Rejected at the upsert
 *    handler when the topic's `lifecycle_policy !== 'historical'`.
 *  - `'pinned'` — user-correction write. Privilege-gated at the
 *    handler: `authored_by` must start with `'system.user_correction'`.
 *    Stamps `is_pinned = 1` on the new row so cascade-driven recompute
 *    paths skip it. P5 ships the gate + storage flag; P7 wires the
 *    `vote.write` consumer that calls it. */
export type EnrichmentUpsertMode = 'overwrite' | 'supersede' | 'pinned';

export const ENRICHMENT_UPSERT_MODES: ReadonlyArray<EnrichmentUpsertMode> = [
  'overwrite',
  'supersede',
  'pinned',
] as const;

/** D-136 §A.9 — recipe-pinned author prefix that gates `mode: 'pinned'`.
 *  The kernel `enrichment-upsert` handler rejects the mode unless
 *  `authored_by` starts with this string. P7's `vote.write` consumer
 *  composes its `authored_by` value as `'system.user_correction.<vote_id>'`. */
export const ENRICHMENT_PINNED_AUTHOR_PREFIX = 'system.user_correction';

/** D-136 §A.11 — closed list of vote kinds. Each kind routes
 *  differently through the vote consumer:
 *    - `'correct'`     → reset failure_attempt_count on the row.
 *    - `'wrong'` /
 *      `'stale'`       → enqueue `lifecycle_action_pending = 'recompute'`
 *                        (or tombstone-with-id when temporal_class +
 *                        lifecycle_policy disallow recompute).
 *    - `'corrected'`   → write user-pinned row via `enrichment-upsert`
 *                        with `mode: 'pinned'` + `authored_by` derived
 *                        from `ENRICHMENT_PINNED_AUTHOR_PREFIX` +
 *                        `vote_id`. Subsequent recompute checks pin →
 *                        no-op.
 *    - `'irrelevant'`  → soft-suppress topic for the (scope, target_id);
 *                        recipes still resolve the row; UI hides it. */
export type EnrichmentVoteKind =
  | 'correct'
  | 'wrong'
  | 'stale'
  | 'irrelevant'
  | 'corrected';

export const ENRICHMENT_VOTE_KINDS: ReadonlyArray<EnrichmentVoteKind> = [
  'correct',
  'wrong',
  'stale',
  'irrelevant',
  'corrected',
] as const;

/** D-136 §A.11 — closed list of vote sources. Each source carries a
 *  different identity + permission expectation; the handler enforces
 *  the source-vs-client validation matrix before persisting:
 *    - `'user_dismissal'` / `'user_action'` — paired-client (D-121),
 *      read-tier permission. Surfaced UX: dismiss / accept-action.
 *    - `'explicit_correction'` — paired-client, write-tier. Required
 *      for `vote: 'corrected'`.
 *    - `'agent_action'` — MCP-channel agent (D-120 agent-watcher
 *      scope). Per-recipe agent permission applies; the handler
 *      stamps `agent_session_id` + `agent_sub_path` from the dispatch
 *      envelope. */
export type EnrichmentVoteSource =
  | 'user_dismissal'
  | 'user_action'
  | 'explicit_correction'
  | 'agent_action';

export const ENRICHMENT_VOTE_SOURCES: ReadonlyArray<EnrichmentVoteSource> = [
  'user_dismissal',
  'user_action',
  'explicit_correction',
  'agent_action',
] as const;

/** D-136 §A.14.2 — closed-list compression-class advisory annotation.
 *  Surfaces in `registry.describe` per-topic response (P7 wires the
 *  rpc; P3 ships the registry-level annotation). Consumer agents read
 *  it to decide whether to trust the warehouse value or fall through
 *  to raw source.
 *
 *  - `'lossless'` — value preserves all source information
 *    (e.g. `embedding` is a deterministic transform; `working_group`
 *    is a canonical attendee list; `attribution_signal` is categorical
 *    from a deterministic rule).
 *  - `'lossy'` — value distills source through compression that
 *    loses nuance (`summary`, `preparation_notes`, `purpose`,
 *    `action_items`, `topic_cluster.summary`). Agents reasoning about
 *    high-stakes decisions fall through to raw.
 *  - `'derived'` — value is a function of source data with
 *    well-defined semantics (counts, percentiles, classifications).
 *    Neither lossless nor narrative-lossy. */
export type CompressionClass = 'lossless' | 'lossy' | 'derived';

/** D-136 §A.14.2 — closed list of compression classes. Validator-
 *  required field at registration (`validateLifecycleDefinition`). */
export const ALL_COMPRESSION_CLASSES: ReadonlyArray<CompressionClass> = [
  'lossless',
  'lossy',
  'derived',
];

/** D-136 §A.14.3 — `prompt_bias_hints` shape regex. Shape-only
 *  (lowercase ASCII words separated by underscores); vocabulary is
 *  open. The validator enforces shape so authors don't drift to
 *  free-form prose; consumer agents hashing on hint values benefit
 *  from a stable canonical form. */
export const PROMPT_BIAS_HINT_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** D-136 §A.13.5 — closed-list MCP read-exposure annotation.
 *  Default `'public'` — Recued is a personal-data warehouse the user
 *  owns; default-gating MCP reads is paternalism, not safety. The
 *  user-permissive default keeps swarm agents fast; D-120's agent-
 *  watcher logs every read for audit visibility. `'private'` opts a
 *  topic out of MCP entirely: `registry.describe` omits it,
 *  `enrichment.read` and `vector.similarity_search` reject reads on
 *  it. Reserved for genuinely sensitive surfaces. Substrate-private
 *  rows (vote contents, `system.user_correction.*` author rows) stay
 *  invisible regardless — the gate sits on top of those filters, not
 *  in place of them. Writes via MCP stay privilege-gated per-rpc; this
 *  annotation governs the *read* surface only. */
export type MCPExposurePolicy = 'public' | 'private';

/** D-136 §A.13.5 — closed list of MCP exposure policies. Validator
 *  rejects any other value when the optional `mcp_exposed` field is
 *  set on an `EnrichmentDefinition`. */
export const ALL_MCP_EXPOSURE_POLICIES: ReadonlyArray<MCPExposurePolicy> = [
  'public',
  'private',
];

/** D-136 §A.14.4 — fallback coverage-quality threshold. Topics that
 *  omit the optional `coverage_quality_threshold` field on
 *  `EnrichmentDefinition` resolve to this value. 50 is a deliberate
 *  middle ground — enough rows to discriminate "novel query" from
 *  "well-covered" without forcing every topic to declare its own
 *  threshold. The default is overridable per-topic; the spec's worked
 *  example (`behavioral_signature: 100`, `lifecycle_stage_inferred:
 *  50`) is exactly the "default + selective override" pattern. */
export const DEFAULT_COVERAGE_QUALITY_THRESHOLD = 50;

/** D-136 §A.14.4 — derived `coverage_quality` band. `registry.describe`
 *  computes this at rpc-call time from row_count + latest_event_at +
 *  producer_failure_rate_24h; surfaces on each `RegistryDescribeTopicEntry`.
 *  Closed list — agents reasoning about pre-flight discrimination only
 *  see one of these four. */
export type CoverageQuality =
  | 'high'
  | 'medium'
  | 'low'
  | 'novel_query_likely_uncovered';

/** D-136 §A.14.4 — closed list of coverage-quality bands. Test
 *  ratchet + agent-side dispatch enumerate against this. */
export const ALL_COVERAGE_QUALITY_BANDS: ReadonlyArray<CoverageQuality> = [
  'high',
  'medium',
  'low',
  'novel_query_likely_uncovered',
];

/** D-136 §A.14.4 — resolve a topic's coverage-quality threshold. Returns
 *  the explicit registry value when declared; otherwise the module-level
 *  default. Pure projection — exposed so the rpc handler + tests + future
 *  Settings UI share one source of truth. */
export const resolveCoverageQualityThreshold = (topic: string): number => {
  if (!isEnrichmentTopic(topic)) return DEFAULT_COVERAGE_QUALITY_THRESHOLD;
  const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
  if (
    typeof def.coverage_quality_threshold === 'number'
    && Number.isFinite(def.coverage_quality_threshold)
    && def.coverage_quality_threshold > 0
  ) {
    return def.coverage_quality_threshold;
  }
  return DEFAULT_COVERAGE_QUALITY_THRESHOLD;
};

/** D-136 §A.14.4 / §A.14.5 — convert an `EnrichmentRecomputeCadence`
 *  string to milliseconds. `'never'` returns null (no cadence implies
 *  no time-based staleness gate). Used by the coverage-quality
 *  derivation (× 2 / × 10 multipliers per spec table) and by the
 *  freshness-budget aggregate-window dispatch (`window_drift` axis). */
export const cadenceToMs = (
  cadence: EnrichmentRecomputeCadence | undefined,
): number | null => {
  if (cadence === undefined || cadence === 'never') return null;
  switch (cadence) {
    case '6h':
      return 6 * 60 * 60 * 1000;
    case '24h':
      return 24 * 60 * 60 * 1000;
    case '7d':
      return 7 * 24 * 60 * 60 * 1000;
    default: {
      const _exhaustive: never = cadence;
      void _exhaustive;
      return null;
    }
  }
};

/** Validator-style schema. Returns the value cast to its narrow type on
 *  success or an array of issue strings on failure. Contracts package
 *  is dep-free so we don't pull Zod here; producers can layer their
 *  own Zod schema and wrap in this shape. */
export type EnrichmentValueValidator<T = unknown> = (value: unknown) =>
  | { ok: true; value: T }
  | { ok: false; issues: string[] };

/** D-134 — open-vocabulary tag string with required `<namespace>:<value>`
 *  shape. Validated via `assertEnrichmentTagShape`. The chip-filter UI
 *  groups tags by namespace prefix and intersects across multiple
 *  selected chips. See `RECOMMENDED_TAG_NAMESPACES` for conventional
 *  namespaces; the validator only enforces shape, not vocabulary. */
export type EnrichmentTag = `${string}:${string}`;

/** D-134 — recommended namespace conventions. Open vocabulary — any
 *  `<ns>:<val>` string passes the validator — but staying within these
 *  conventions keeps the chip-filter UI legible and avoids one-off
 *  namespaces drifting per producer.
 *
 *  - **Auto-derived from registry** (`domain` / `policy` / `shape` /
 *    `kind`) — `deriveStandardEnrichmentTags` computes these from the
 *    `EnrichmentDefinition`. Authors don't hand-write these; the
 *    registry field is the source of truth and the auto-derived tag
 *    follows.
 *  - **Auto-derived from instance** (`surface`) — `surface:ai` /
 *    `surface:deterministic` is stamped at task-instance build time
 *    when the producer's `ai_surface` is known. Not derivable from the
 *    registry alone.
 *  - **Author-declared** (`platform` / `industry` / `department`) —
 *    typed into the registry entry's `tags` field. Authors hand-write
 *    1-3 tags max; the rest auto-derive. */
export const RECOMMENDED_TAG_NAMESPACES = [
  'surface',     // ai / deterministic — auto from instance
  'domain',      // mail / contact / calendar / connection / file — auto from valid_scopes
  'policy',      // dependent / aggregate / members_list / independent — auto
  'shape',       // per_record / derived_entity — auto
  'kind',        // reactive / housekeeping / core — auto
  'platform',    // hubspot / salesforce / linear / bamboohr / ... — author-declared
  'industry',    // saas / legal / healthcare / ... — author-declared
  'department',  // hr / sales / finance / ops / eng / support / legal — author-declared
] as const;

export type RecommendedTagNamespace = typeof RECOMMENDED_TAG_NAMESPACES[number];

export interface ParsedEnrichmentTag {
  namespace: string;
  value: string;
}

/** Parse a tag into namespace + value. Returns null when the shape is
 *  invalid (no separator, empty halves, or whitespace bordering the
 *  separator). Strict on whitespace — `'platform: hubspot'` fails so
 *  copy-paste typos surface in the validator instead of producing
 *  silently broken chips. */
export const parseEnrichmentTag = (tag: string): ParsedEnrichmentTag | null => {
  if (typeof tag !== 'string' || tag.length === 0) return null;
  const idx = tag.indexOf(':');
  if (idx <= 0 || idx >= tag.length - 1) return null;
  const namespace = tag.slice(0, idx);
  const value = tag.slice(idx + 1);
  if (namespace.trim() !== namespace) return null;
  if (value.trim() !== value) return null;
  if (namespace.length === 0 || value.length === 0) return null;
  return { namespace, value };
};

/** Validator returning `string[]` of issues — empty array means OK.
 *  Matches the shape of `assertEnrichmentTrustDefaults` so registry-
 *  level batch validators can flatmap across topics. */
export const assertEnrichmentTagShape = (tag: unknown): string[] => {
  if (typeof tag !== 'string') return ['tag must be a string'];
  if (tag.length === 0) return ['tag is empty'];
  if (parseEnrichmentTag(tag) === null) {
    return [`tag '${tag}' must match <namespace>:<value> with no whitespace bordering ':'`];
  }
  return [];
};

export interface EnrichmentDefinition {
  shape: EnrichmentShape;
  /** Shape A only — closed list of source collections that may carry
   *  the topic. Producers writing to a scope outside this list throw
   *  `enrichment_scope_unsupported`. */
  valid_scopes?: ReadonlyArray<EnrichmentScope>;
  value_schema: EnrichmentValueValidator;
  policy: EnrichmentPolicy;
  producer_kind: EnrichmentProducerKind;
  // ── policy-specific config ────────────────────────────────────
  /** `members_list` only — JSON `value` field carrying the list of
   *  source-record ids. Cascade engine reads + rewrites this field on
   *  source delete. */
  members_field?: string;
  /** `members_list` only — which collection the list members are drawn
   *  from. Cascade engine narrows by `(scope === members_scope)`. */
  members_scope?: EnrichmentScope;
  /** `aggregate` only — collections the housekeeping fold reads from.
   *  `'audit'` and `'data_enrichment'` are time-travelable per audit §5
   *  (append-only); other scopes are not (mail/calendar/contact/CRM
   *  surface fields can change).
   *
   *  ⚠ `'audit'` WAS SPELLED `'memory'` until 2026-08-11. It always meant the
   *  run-provenance trail (`audit_entries` / `audit_activities`) — D-120's
   *  `data.memory.*`, before D-231 split that namespace and promoted
   *  `data.audit.*` to canonical. It has NEVER meant `user_memory`, the owner's
   *  curated pool: nothing in `housekeeping/` or the enrichment store has ever
   *  read that table, and the append-only claim above would be FALSE of it
   *  (D-198 gave it update + delete).
   *
   *  ⛔ THE OLD NAME WAS A LOADED GUN, not just confusing. The cascade routes
   *  with `def.aggregates_from.includes(scope)` — so the day someone added a
   *  `'memory'` arm to `EnrichmentScope` for the owner pool, every write to it
   *  would have fanned into the three `connection_*` topics that aggregate the
   *  AUDIT log, marking them stale and enqueuing recompute. TypeScript could
   *  not have caught it: `EnrichmentScope | 'memory'` with `'memory'` already
   *  in `EnrichmentScope` collapses to one union, silently. A member of this
   *  list must never also be an `EnrichmentScope` (ratcheted in
   *  `d-136-phase-1-lifecycle.test.ts`). */
  aggregates_from?: ReadonlyArray<EnrichmentScope | 'audit' | 'data_enrichment'>;
  /** `aggregate` only — drift-correction interval. Producers may
   *  ignore + run incremental-only when `'never'`. */
  recompute_cadence?: EnrichmentRecomputeCadence;
  /** `aggregate` only — when true, the producer exposes a streaming
   *  `unfoldOne(state, source)` shape so the housekeeping loop can
   *  fold one new source at a time without re-walking history. */
  supports_unfold?: boolean;
  // ── storage ───────────────────────────────────────────────────
  sidecar?: EnrichmentSidecar;
  // ── user-facing copy ──────────────────────────────────────────
  name: string;
  description: string;
  /** "You can use this to …" — surfaced on the Housekeeping page next
   *  to the producer's controls. */
  user_value: string;
  // ── D-132 trust gate registry defaults ────────────────────────
  /** Author-declared default trust state on first registration.
   *  AI-surface housekeeping producers must declare `'manual'` (or
   *  omit, defaulting to `'manual'`); deterministic / reactive
   *  producers should declare `'auto'` (or omit, defaulting to
   *  `'auto'` for `producer_kind: 'reactive'`). The validator gate
   *  rejects `'auto'` on AI-surface housekeeping producers — see
   *  `assertEnrichmentTrustDefaults` in this module. */
  default_trust_state?: 'off' | 'manual' | 'auto';
  /** Author-declared default pool routing on first registration.
   *  Ignored for deterministic producers (zero-token cost — no source
   *  to pick from). Recommended values: cheap-and-noisy producers
   *  (`summary`-like) → `'free_only'`; quality-sensitive producers
   *  (`deal_health_score`-like) → `'free_then_byok'`. */
  default_pool_policy?: 'free_only' | 'free_then_byok' | 'byok_only';
  /** D-133 — true iff the producer's persisted `value` carries a
   *  numeric `confidence` field in the LLM-output sense (proportion
   *  in `[0, 1]`). The `confidence_drift_signal` housekeeping
   *  producer iterates only over topics flagged here so it doesn't
   *  walk producers whose output has no notion of confidence. */
  emits_confidence?: boolean;
  /** D-134 — author-declared tags driving the chip-filter UI on
   *  Settings → Server → Housekeeping. Hand-write only the tags that
   *  carry real information beyond what the registry already encodes —
   *  `platform:` (vendor), `industry:` (vertical), `department:`
   *  (business function). The `domain:` / `policy:` / `shape:` /
   *  `kind:` tags auto-derive from `valid_scopes` / `policy` / `shape`
   *  / `producer_kind` via `deriveStandardEnrichmentTags`; the
   *  `surface:` tag stamps at task-instance build time. Tags that
   *  duplicate auto-derived ones are harmless — `collectEnrichmentTags`
   *  dedupes — but pollute the chip ordering, so prefer to omit them.
   *
   *  Vocabulary is open. Validator (`assertEnrichmentTagShape`) only
   *  enforces `<namespace>:<value>` shape — see
   *  `RECOMMENDED_TAG_NAMESPACES` for conventions. */
  tags?: ReadonlyArray<EnrichmentTag>;
  // ── D-136 lifecycle & temporal substrate ──────────────────────
  /** D-136 §A.1 — what kind of fact the topic captures. Required.
   *  Gates `recompute_on_drift` (validator rejects on time_bound) and
   *  `emits_confidence` (validator rejects on non-stable_truth — PSI is
   *  only meaningful on stable_truth topics). */
  temporal_class: TemporalClass;
  /** D-136 §A.1 — what kind of identity the row keys on. Required.
   *  Perspective topics MUST declare `identity_extractor` so cascade
   *  fan-in can invalidate when contributing sources update. */
  identity_aggregation: IdentityAggregation;
  /** D-136 §A.2 — how the row is regenerated / retired. Required.
   *  `'manual_pinned'` is runtime-only (set by user-correction votes);
   *  validator rejects it at registration. */
  lifecycle_policy: Exclude<LifecyclePolicy, 'manual_pinned'>;
  /** D-136 §A.1 — value-field carrying the snapshot timestamp.
   *  REQUIRED on non-stable_truth topics (validator gate). Stable_truth
   *  topics may omit (the value is event-time-anchored by definition). */
  as_of_field?: string;
  /** D-136 §A.1 — for aggregate_window topics: which clock anchors
   *  the trailing window. REQUIRED on aggregate_window topics
   *  (validator gate). Fixes audit §24.1 A2 — first-install backfill
   *  ambiguity. */
  aggregate_window_axis?: AggregateWindowAxis;
  /** D-136 §A.10 — signal aperture in milliseconds. Decoupled from
   *  `recompute_cadence` (freshness budget). Pack-install + user
   *  overrides flow through this field; effective value is folded
   *  into `input_fingerprint_hash` so changes force recompute. */
  aggregate_window_ms?: number;
  aggregate_window_user_configurable?: boolean;
  aggregate_window_min_ms?: number;
  aggregate_window_max_ms?: number;
  /** D-136 §A.2 — TTL for `lifecycle_policy: 'ttl'` topics. REQUIRED
   *  when policy is `'ttl'` (validator gate). */
  ttl_days?: number;
  ttl_user_configurable?: boolean;
  ttl_min_days?: number;
  ttl_max_days?: number;
  /** D-136 §A.5 — extracts canonical identity key(s) from a source
   *  record. REQUIRED on perspective topics so cascadeForIdentityChange
   *  can fan in. P1 ships sentinel values; P5 wires the cascade. */
  identity_extractor?: IdentityExtractor;
  /** D-136 §A.5 — closed list of upstream enrichment topics this
   *  topic's producer consumes. Drives cascadeForUpstreamEnrichment
   *  invalidation in P5. */
  consumes_topics?: ReadonlyArray<string>;
  /** D-136 §A.3 — how the producer composes its `input_fingerprint_hash`.
   *  REQUIRED on aggregate_window / perspective / upstream-consuming
   *  topics (validator gate); per-record producers may omit
   *  (degenerates to `source_record_hash`). P1 ships the type +
   *  validator; P3 retrofits producer code. */
  inputFingerprintComposition?: InputFingerprintComposition;
  /** D-136 §A.14.2 — author-declared compression class, advisory.
   *  REQUIRED at registration (validator gate). Surfaces in
   *  `registry.describe` (P7) so consumer agents reasoning about
   *  high-stakes queries can decide whether to trust the warehouse
   *  value or fall through to the raw source. The classification
   *  table at P3 retrofit (§A.14.2):
   *    - lossy:    purpose / summary / action_items /
   *                preparation_notes / topic_cluster
   *    - lossless: embedding / working_group / attribution_signal
   *    - derived:  everything else (counts, percentiles,
   *                classifications, deterministic aggregates). */
  compression_class: CompressionClass;
  /** D-136 §A.14.3 — open-vocabulary list of prompt-bias indicators
   *  for AI-surface producers (advisory). Surfaces in
   *  `registry.describe` so consumer agents can apply skeptical
   *  priors. Validator enforces shape only — entries must match
   *  `PROMPT_BIAS_HINT_RE` (lowercase ASCII words separated by
   *  underscores). Vocabulary is open: authors describe the bias
   *  precisely. The vote substrate (§A.11) handles
   *  empirical-correction-over-time; this field is the explicit-
   *  author-disclosure path. */
  prompt_bias_hints?: ReadonlyArray<string>;
  /** D-136 §A.13.5 — author-declared MCP read-exposure policy.
   *  Default `'public'` (omit the field to inherit the default).
   *  Setting `'private'` opts the topic out of every MCP read surface
   *  (`registry.describe` omits it; `enrichment.read` +
   *  `vector.similarity_search` reject reads on it). Substrate-private
   *  filters (`system.user_correction.*` author prefix, vote-table
   *  contents) remain in force regardless of this annotation — they
   *  layer below it. Writes via MCP stay privilege-gated per-rpc; this
   *  annotation governs the read surface only. Validator gate 11
   *  rejects any value outside the closed list when the field is set. */
  mcp_exposed?: MCPExposurePolicy;
  /** D-136 §A.14.4 — coverage-quality threshold informing the
   *  `'high' | 'medium' | 'low' | 'novel_query_likely_uncovered'`
   *  derivation in `registry.describe`. Optional — omit to inherit the
   *  module-level default `DEFAULT_COVERAGE_QUALITY_THRESHOLD`. The
   *  number is the row count at which the topic is considered fully
   *  covered: `> threshold` rows + recent producer run + low failure
   *  rate → `'high'`; the bands taper from there. Author-declared per
   *  topic; spec calls out `behavioral_signature: 100` and
   *  `lifecycle_stage_inferred: 50` as worked examples. Pure advisory —
   *  no execution-semantics impact, only the response field. */
  coverage_quality_threshold?: number;
  /** D-139 § A.9.3 — declares whether the topic populates per-output
   *  `coverage` metadata (`sources_connected` / `sources_unavailable` /
   *  `sources_stale` / `sources_degraded` / `row_counts` /
   *  `last_source_event_at`). D-139 is the substrate widening that
   *  drives this field — every D-139-tagged topic ships with it
   *  `true` at registry-load. Pre-D-139 topics treat the slot as
   *  optional + absent (Pass-4 R4.9 — D-139 doesn't retrofit other
   *  Ds at v1; future Ds may backfill). Validator gate at registry-
   *  load asserts presence on every D-139 topic; producers wire the
   *  coverage bundle through to enrichment-upsert downstream. */
  populates_coverage?: boolean;
  // ── D-139 P5 — evidence-quality consumption defaults ──────────
  // Closed-list registry annotations declaring how a topic's producer
  // filters its `EngagementRow` inputs at compute time. Pass-4 reframe
  // elevated these from producer-side comments into substrate
  // contracts; D-139 P5 wires them as registry fields so the harness
  // can pre-filter input sets before LLM compute (no token spend on
  // rows the producer would skip anyway). All four fields are
  // optional — pre-P5 producers continue to bake the defaults into
  // their algorithm + leave the slots NULL. Validator gate (when the
  // field is present) closes the list against the substrate enums in
  // `engagement-evidence.ts`.
  /** § A.3 — closed list of `BodyState` values whose rows the
   *  producer accepts as input. AI producers reading body content
   *  declare this so the harness skips rows whose body isn't
   *  available. Default per § A.3.5 is "skip `'none'` +
   *  `'truncated_inline'`"; producers that can use truncated previews
   *  override (e.g. `engagement_sentiment_trend` — tone-from-preview
   *  is partial-but-useful). */
  body_state_acceptance?: ReadonlyArray<BodyState>;
  /** § A.3.2 — closed list of `Authorship` values whose rows the
   *  producer accepts. AI-surface evidence-bearing topics typically
   *  declare `['user', 'crm_user', 'unknown']` to skip `'crm_automation'`
   *  + `'system_process'` — tracking-pixel rows + workflow auto-logs
   *  are meaningless for tone analysis / next-action recommendation. */
  authorship_acceptance?: ReadonlyArray<Authorship>;
  /** § A.3.6 — closed list of `EngagementLifecycleState` values whose
   *  rows the producer accepts. AI-surface evidence-bearing topics
   *  typically declare `['point_in_time', 'completed']` so pending
   *  tasks + scheduled meetings + cancelled rows + failed sends
   *  + no-answer calls aren't fed to the LLM. */
  lifecycle_state_acceptance?: ReadonlyArray<EngagementLifecycleState>;
  /** § A.3.5 — producer's collapse policy across `dedupe_confidence`
   *  values. Default `'exact_only'` (over-counts probable-twin pairs);
   *  `'probable'` collapses probable twins; `'all'` collapses
   *  regardless. AI-surface tone / NBA producers set `'exact_only'`
   *  to avoid conflating distinct commitments. */
  dedupe_acceptance?: DedupeAcceptance;
  /** D-161 P2 — input-provenance trust: the closed list of `origin_actor`
   *  write-actor classes whose source rows this producer accepts. The
   *  housekeeping harness skips a source row whose P1 `origin_actor` stamp
   *  isn't in this set — *filtered for this producer*, never *excluded
   *  from the warehouse* (I-7). A **distinct axis** from D-132's
   *  `enrichment_trust` (cost / consent): evaluated independently (I-8).
   *  Distinct too from `authorship_acceptance` above — that gates the
   *  *external content author* of `system`-ingested mail; this gates the
   *  *write-actor* of the row (Reception `anonymous`, MCP
   *  `contracted_user`). Composes with it where both matter (A.5).
   *
   *  **Optional with a security default**: an undeclared producer accepts
   *  `user_self` + `system` only (`DEFAULT_ORIGIN_ACCEPTANCE`) — never
   *  auto-exposed to `anonymous` / `contracted_user` input (N.9 MUST /
   *  TR-7). A producer that should consume outside-actor content opts in
   *  explicitly (e.g. a Reception-lead enricher declares
   *  `['user_self', 'system', 'anonymous']`). When declared it must be
   *  non-empty — `buildEnrichmentProducerTask` rejects an empty list (an
   *  empty list is "accept nothing", almost certainly a misconfiguration;
   *  omit the field for the conservative default instead). */
  origin_acceptance?: ReadonlyArray<Actor>;
  /** Bench-harvested return-shape declaration (mirrors the per-topic
   *  `EnrichmentDeclaration.return_shape` field that PA9 declarations
   *  carry, but inlined on registry entries that don't have a separate
   *  declaration file). Authored verbatim from `recued-enrichment-
   *  benchmark/scenario-engine/src/enrichment-episodes/catalog.js` so
   *  LLM-facing surfaces (`registry.describe` / catalog rendering /
   *  MCP `entity.query` tool descriptions) carry the same REF<X>
   *  annotations the bench uses. Optional today; the bench-aligned
   *  ratchet (`d-145-bench-return-shape-harvest.ratchet.test.ts`)
   *  asserts presence on every bench-catalog topic so future bench
   *  additions surface as a test failure here. */
  return_shape?: string;
}

// ────────────────────────────────────────────────────────────────
// Lightweight value-schema helpers
// ────────────────────────────────────────────────────────────────

/** Stand-in for unfinished schemas — accepts any object. Reserved-topic
 *  entries that subsequent housekeeping producers (post-D-123) will
 *  tighten use this so the registry compiles today. */
const acceptObject: EnrichmentValueValidator = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  return { ok: true, value };
};

/** Object-shape validator factory. Verifies that every key in `expected`
 *  passes its predicate; extra keys are allowed (forward-compatible
 *  with producer revisions). Issues come back keyed by field path. */
const objectShape = <T>(
  expected: Record<string, (v: unknown) => boolean>,
): EnrichmentValueValidator<T> => (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  for (const key of Object.keys(expected)) {
    if (!expected[key]!(obj[key])) {
      issues.push(`field '${key}' failed validation`);
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as T };
};

const isString = (v: unknown): boolean => typeof v === 'string';
const isOptionalString = (v: unknown): boolean => v === undefined || typeof v === 'string';
const isNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
const isOptionalNumber = (v: unknown): boolean => v === undefined || isNumber(v);
const isNumberOrNull = (v: unknown): boolean => v === null || isNumber(v);
const isStringArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every((item) => typeof item === 'string');

// Phase 1 harvest helpers — validate resolved-name `[{entity, name}]`
// arrays. Both accept `undefined` (the field is optional during the
// producer-shape harvest); reject non-arrays and non-conforming entries.
const isContactsResolvedArray = (v: unknown): boolean => {
  if (v === undefined) return true;
  if (!Array.isArray(v)) return false;
  for (const entry of v) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.entity !== 'string' || typeof obj.name !== 'string') return false;
  }
  return true;
};
const isThreadSignalsParticipantArray = isContactsResolvedArray;

// ────────────────────────────────────────────────────────────────
// Concrete value schemas — the three reactive producers ship in D-122
// ────────────────────────────────────────────────────────────────

export interface ContactTimelineRollupValue {
  /** Resolved subject-contact name (denormalized from the contacts
   *  directory at producer-run time). Harvest phase 1b. Optional. */
  name?: string;
  /** Subject-contact REF<contacts> identifier (today: canonical email).
   *  Optional during the producer-shape harvest. */
  entity?: string;
  /** Cumulative interaction count over the rollup window. */
  interaction_count: number;
  /** Last activity epoch ms (mail received/sent or calendar event). */
  last_interaction: number;
  /** Top up to 5 most-recent thread / event subjects, oldest → newest. */
  recent_subjects: string[];
  /** Cursor written-by side: epoch ms of the latest source row folded
   *  into the rollup. Used by the producer to skip already-seen rows. */
  cursor_at: number;
  /** D-136 §A.10 — aggregate window the row was computed against,
   *  in milliseconds. Mirrors the topic's
   *  `ENRICHMENT_REGISTRY.contact_timeline_rollup.aggregate_window_ms`
   *  default; pack-install + user overrides flow through this field. */
  window_ms: number;
}

const ContactTimelineRollupSchema = objectShape<ContactTimelineRollupValue>({
  name: isOptionalString,
  entity: isOptionalString,
  interaction_count: isNumber,
  last_interaction: isNumber,
  recent_subjects: isStringArray,
  cursor_at: isNumber,
  window_ms: isNumber,
});

export interface CalendarEventRollupValue {
  /** Pre-rendered meeting brief — the alert recipe surfaces this
   *  verbatim in the notification body. */
  brief: string;
  /** Canonical attendee email list — used by the alert renderer to
   *  decorate names. Up to 16 entries; longer lists truncate. */
  attendees: string[];
  /** Resolved-name surface for attendees (pre-resolved via the contacts
   *  directory at producer-run time). Each entry is `{ entity, name }`
   *  parallel to `attendees: string[]`. Harvest phase 1b — optional. */
  attendees_resolved?: ReadonlyArray<{ entity: string; name: string }>;
  /** Up to 3 thread ids the rollup considers related (recent mail
   *  with overlapping participants). Empty when no signal. */
  related_thread_ids: string[];
  /** Generation cursor — epoch ms when the producer last refreshed
   *  this rollup. Cascade-marks-stale resets to 0 on source update. */
  generated_at: number;
  /** D-136 §A.10 — aggregate window the row was computed against,
   *  in milliseconds. Mirrors the topic's registry
   *  `aggregate_window_ms` default. */
  window_ms: number;
}

const CalendarEventRollupSchema = objectShape<CalendarEventRollupValue>({
  brief: isString,
  attendees: isStringArray,
  related_thread_ids: isStringArray,
  generated_at: isNumber,
  window_ms: isNumber,
  attendees_resolved: isContactsResolvedArray,
});

export interface MeetingRescheduleValue {
  /** Resolved subject-contact name (denormalized from the contacts
   *  directory at producer-run time). Harvest phase 1b. Optional. */
  name?: string;
  /** Subject-contact REF<contacts> identifier (today: canonical email).
   *  Optional during the producer-shape harvest. */
  entity?: string;
  /** Number of reschedules observed for the contact in the rolling
   *  window (default 90 days; see `window_ms`). */
  reschedule_count: number;
  /** Sliding sample: up to 8 most-recent reschedule timestamps the
   *  pattern fired on. */
  recent_at: number[];
  /** Producer cursor — last calendar.updated event_at folded in. */
  cursor_at: number;
  /** Optional human-readable reason ("frequent < 24h reschedules";
   *  "no-show pattern", etc.). Recipe-author-friendly hint surfaced
   *  in the alert body. */
  reason?: string;
  /** D-136 §A.10 — aggregate window the row was computed against,
   *  in milliseconds. Mirrors the topic's registry
   *  `aggregate_window_ms` default (default 90d). */
  window_ms: number;
}

const MeetingRescheduleSchema: EnrichmentValueValidator<MeetingRescheduleValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.reschedule_count)) issues.push("field 'reschedule_count' must be a finite number");
  if (!Array.isArray(obj.recent_at) || !(obj.recent_at as unknown[]).every(isNumber)) {
    issues.push("field 'recent_at' must be an array of numbers");
  }
  if (!isNumber(obj.cursor_at)) issues.push("field 'cursor_at' must be a finite number");
  if (!isOptionalString(obj.reason)) issues.push("field 'reason' must be string when present");
  if (!isNumber(obj.window_ms)) issues.push("field 'window_ms' must be a finite number");
  if (!isOptionalString(obj.name)) issues.push("field 'name' must be string when present");
  if (!isOptionalString(obj.entity)) issues.push("field 'entity' must be string when present");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as MeetingRescheduleValue };
};

// `thread_signals` (D-123 canary) is the first deterministic per-mail
// housekeeping topic. Aggregates over every mail sharing `thread_id`
// (no time window — the `recompute_cadence: '24h'` knob refreshes the
// rollup but the producer folds the entire thread, not a 24h slice).
// D-136 P3 follow-up replaced the legacy `acceptObject` schema with
// this concrete validator so the registry enforces the contract at
// upsert / store-validation paths.

export interface ThreadSignalsValue {
  thread_id: string;
  message_count: number;
  participant_count: number;
  /** Integer day-count between the earliest and latest sibling
   *  `received_at`. Zero for single-message threads. */
  span_days: number;
  /** True iff any sibling carries `is_read: false`. */
  has_unread: boolean;
  /** Canonical thread subject — latest sibling's subject after
   *  reply-thread normalization. Harvest from
   *  internal benchmarks v6/v9 — bench measured 9.8K
   *  tokens/episode and mean 4 hops because the agent had to
   *  follow up with entity.query(mail) to learn the subject.
   *  Optional during the producer-shape harvest. */
  subject?: string;
  /** Resolved-name surface for thread participants. Each entry is
   *  `{ entity: REF<contacts>, name: string }`; pre-resolved at
   *  producer-run time so the agent identifies participants without
   *  follow-up entity.query lookups. Optional during the harvest. */
  participant_contacts?: ReadonlyArray<{ entity: string; name: string }>;
  /** Epoch-ms of the most recent sibling's `received_at`. Lets the
   *  agent report thread recency without a follow-up entity.query on
   *  mail. Optional during the harvest. */
  latest_received_at?: number;
}

const ThreadSignalsSchema = objectShape<ThreadSignalsValue>({
  thread_id: isString,
  message_count: isNumber,
  participant_count: isNumber,
  span_days: isNumber,
  has_unread: (v: unknown): boolean => typeof v === 'boolean',
  subject: isOptionalString,
  participant_contacts: isThreadSignalsParticipantArray,
  latest_received_at: isOptionalNumber,
});

export interface TranscriptValue {
  text: string;
  language?: string;
  duration_s?: number;
  model?: string;
}

const TranscriptSchema = objectShape<TranscriptValue>({
  text: isString,
  language: isOptionalString,
  duration_s: isOptionalNumber,
  model: isOptionalString,
});

export interface CaptionValue {
  caption: string;
  model?: string;
}

const CaptionSchema = objectShape<CaptionValue>({
  caption: isString,
  model: isOptionalString,
});

export interface ExtractedTextValue {
  text: string;
  page_count?: number;
  model?: string;
}

const ExtractedTextSchema = objectShape<ExtractedTextValue>({
  text: isString,
  page_count: isOptionalNumber,
  model: isOptionalString,
});

// ── Concrete value schemas — housekeeping AI producers ─────────
// `embedding` (A.3 of the launch sequence) ships the first vector-
// sidecar topic. Recipes read this `value` payload to filter/route by
// dimensions or model; the actual vector lives in
// `data_enrichment_vector_index` and is queried by similarity-search
// recipes (A.17 `semantic_cluster`) rather than read field-by-field.

export interface EmbeddingValue {
  /** Length of the vector. Differs by provider/model — text-embedding-3-small
   *  returns 1536 by default, Gemini text-embedding-004 returns 768.
   *  Recipes querying for nearest-neighbour similarity must filter on
   *  matching dimensions. */
  dimensions: number;
  /** Provider model identifier as the adapter echoed it back (eg.
   *  `text-embedding-3-small`, `models/text-embedding-004`). Recipes
   *  use this together with `dimensions` to cohort vectors before any
   *  cross-record comparison. */
  model: string;
}

const EmbeddingSchema = objectShape<EmbeddingValue>({
  dimensions: isNumber,
  model: isString,
});

// `behavioral_signature` (A.6 of the launch sequence) is the first
// contact-scope housekeeping topic — `aggregate` policy folding
// `data.mail` + `data.calendar` over a per-contact email key. The
// produced value is a deterministic statistical signature of how the
// user interacts with this contact: rolling 30-day mail / meeting
// counts, mean reply latency, last-touch timestamps. Reactive recipes
// read it to tailor follow-up timing to each contact's rhythm
// ("alert me when an A-tier contact's reply latency drops past their
// 7-day mean") without paying per-recipe AI cost.

export interface BehavioralSignatureValue {
  /** Resolved subject-contact name (denormalized from the contacts
   *  directory at producer-run time). Harvest from
   *  internal benchmarks v10 catalog tuning — bench showed
   *  the agent reaches the producer but couldn't tell whose stats
   *  these are without an entity.query lookup. Optional during the
   *  producer-shape harvest. */
  name?: string;
  /** Subject-contact REF<contacts> identifier (today: canonical email).
   *  Forward-aligned with the contact-identifier-expansion follow-on.
   *  Optional during the harvest. */
  entity?: string;
  /** Mail volume involving this contact (From / To / CC) over the
   *  trailing window (default 30d; see `window_ms`). Renamed from
   *  `mail_count_30d` at D-136 P3 follow-up — see audit §25.6. */
  mail_count_window: number;
  /** Mail volume involving this contact across all time. */
  mail_count_total: number;
  /** Calendar events involving this contact (organizer or attendee)
   *  over the trailing window. Renamed from `meeting_count_30d` at
   *  D-136 P3 follow-up. */
  meeting_count_window: number;
  /** Calendar events involving this contact across all time. */
  meeting_count_total: number;
  /** Mean reply latency in ms — averaged across thread-paired samples
   *  where this contact sent inbound mail and the user replied later in
   *  the same thread. `null` when no samples exist (no inbound from the
   *  contact, or no replies yet). */
  mean_reply_latency_ms: number | null;
  /** Sample size feeding `mean_reply_latency_ms`. Zero when the latency
   *  is null. */
  reply_sample_count: number;
  /** Epoch-ms of the most recent calendar meeting involving this
   *  contact (organizer or attendee), or `null` when none exist. */
  last_meeting_at: number | null;
  /** Epoch-ms of the most recent inbound mail from this contact, or
   *  `null` when none exists. */
  last_inbound_at: number | null;
  /** `ctx.now()` when the signature was computed. Recipes read this
   *  to gauge the staleness window of the rolling figures since
   *  the producer is aggregate-policy and only re-derives on contact
   *  hash change or scheduler cadence sweep. */
  computed_at: number;
  /** D-136 §A.10 — aggregate window the row was computed against,
   *  in milliseconds. Mirrors the topic's registry
   *  `aggregate_window_ms` default (default 30d). */
  window_ms: number;
}

const BehavioralSignatureSchema = objectShape<BehavioralSignatureValue>({
  name: isOptionalString,
  entity: isOptionalString,
  mail_count_window: isNumber,
  mail_count_total: isNumber,
  meeting_count_window: isNumber,
  meeting_count_total: isNumber,
  mean_reply_latency_ms: isNumberOrNull,
  reply_sample_count: isNumber,
  last_meeting_at: isNumberOrNull,
  last_inbound_at: isNumberOrNull,
  computed_at: isNumber,
  window_ms: isNumber,
});

// `reply_patterns` (A.7 of the launch sequence) is the second
// contact-scope housekeeping topic — `aggregate` policy reading
// `data.mail` only. Where `behavioral_signature` exposes a single
// mean reply latency + per-contact volume sketch, this topic
// expands to the full distribution (p50 / p95) plus reply RATE —
// "of the inbound mail you've received from this contact in the
// last 30 days, what fraction did you reply to?". Recipes use the
// rate to flag dropped threads ("contact wrote 12 times, you
// replied to 3"), and the percentiles to set per-contact SLO
// alerts ("their p95 just doubled — they're getting frustrated").

export interface ReplyPatternsValue {
  /** Resolved subject-contact name (denormalized from the contacts
   *  directory at producer-run time). Harvest from
   *  internal benchmarks v12a tuning — closes the
   *  shared-mailbox misattribution gap surfaced by the bench. Optional
   *  during the producer-shape harvest. */
  name?: string;
  /** Subject-contact REF<contacts> identifier (today: canonical email).
   *  Forward-aligned with the contact-identifier-expansion follow-on.
   *  Optional during the harvest. */
  entity?: string;
  /** Inbound mail (sender canonicalizes to contact email) over the
   *  trailing window. Volume context for `reply_rate_window`.
   *  Renamed from `inbound_count_30d` at D-136 P3 follow-up. */
  inbound_count_window: number;
  /** Inbound mail in the trailing window that received a reply
   *  (in-thread, addressing the contact). Numerator for
   *  `reply_rate_window`. Renamed from `reply_sample_count_30d` at
   *  D-136 P3 follow-up. */
  reply_sample_count_window: number;
  /** Reply rate over the trailing window —
   *  `reply_sample_count_window / inbound_count_window`. `null` when
   *  the contact sent no inbound mail in the window (no signal yet).
   *  Renamed from `reply_rate_30d` at D-136 P3 follow-up. */
  reply_rate_window: number | null;
  /** All-time count of in-thread reply pairs (any inbound, any later
   *  in-thread reply addressing the contact). Drives the percentile
   *  confidence — recipes typically guard `{{...reply_sample_count}}
   *  greater 5` before reading p95. */
  reply_sample_count: number;
  /** Mean of the all-time latency samples in ms. `null` when no
   *  samples. Mirrors the `mean_reply_latency_ms` field on
   *  `behavioral_signature` so recipes can read either topic with
   *  the same field name. */
  mean_reply_latency_ms: number | null;
  /** Median (p50) reply latency in ms. `null` when no samples. */
  p50_reply_latency_ms: number | null;
  /** 95th-percentile reply latency in ms. `null` when fewer than 5
   *  samples — percentiles are meaningless on tiny samples and the
   *  null surface lets recipes gate on confidence with a single
   *  `is_null` check. */
  p95_reply_latency_ms: number | null;
  /** `ctx.now()` when the row was computed. Recipes read this to
   *  gauge staleness of the rolling window, same shape as
   *  `behavioral_signature.computed_at`. */
  computed_at: number;
  /** D-136 §A.10 — aggregate window the row was computed against,
   *  in milliseconds. Mirrors the topic's registry
   *  `aggregate_window_ms` default (default 30d). */
  window_ms: number;
}

const ReplyPatternsSchema = objectShape<ReplyPatternsValue>({
  name: isOptionalString,
  entity: isOptionalString,
  inbound_count_window: isNumber,
  reply_sample_count_window: isNumber,
  reply_rate_window: isNumberOrNull,
  reply_sample_count: isNumber,
  mean_reply_latency_ms: isNumberOrNull,
  p50_reply_latency_ms: isNumberOrNull,
  p95_reply_latency_ms: isNumberOrNull,
  computed_at: isNumber,
  window_ms: isNumber,
});

// `attendee_patterns` (A.8 of the launch sequence) is the third
// contact-scope housekeeping topic and the first reading calendar-
// only. Surfaces the user's de-facto working groups by counting co-
// attendance: for each contact, who else regularly shows up on the
// same calendar events. Recipes use it for "what cluster does this
// person belong to" inferences and to spot stalled relationships
// (top co-attendee count drops to zero in the 90-day window).

export interface AttendeeCoOccurrence {
  /** Canonical email of the co-attendee. The producer DOES NOT filter
   *  the user's own mailbox — recipes downstream-filter via knowledge
   *  of the user's mail accounts. */
  email: string;
  /** Number of distinct calendar events where the source contact and
   *  this co-attendee both appeared (organizer or attendee). */
  count: number;
  /** Resolved-name surface harvested from the internal benchmarks
   *  v6 catalog tuning — bench measurement showed agents misattribute when
   *  contact references arrive as bare emails. Optional during the
   *  producer-shape harvest (producers gradually emit them); intended to
   *  become required once Phase 2 (producer code update) lands. */
  name?: string;
  /** Generic REF<contacts> identifier — today the canonical email above,
   *  forward-aligned with the contact-identifier-expansion follow-on
   *  (phones / handles / messaging IDs). Optional during the harvest. */
  entity?: string;
}

export interface AttendeePatternsValue {
  /** Resolved subject-contact name (denormalized from the contacts
   *  directory at producer-run time). Harvest from
   *  internal benchmarks v10 catalog tuning — surface let
   *  the agent identify whose patterns these are without an
   *  entity.query lookup. Optional during the producer-shape harvest. */
  name?: string;
  /** Subject-contact REF<contacts> identifier (today: canonical email).
   *  Forward-aligned with the contact-identifier-expansion follow-on.
   *  Optional during the harvest. */
  entity?: string;
  /** Total calendar events (organizer or attendee) involving the
   *  source contact across all time. */
  events_total: number;
  /** Calendar events involving the source contact in the trailing
   *  window (default 90d; see `window_ms`). Wider window than
   *  `behavioral_signature`'s default 30d to catch monthly cycles +
   *  clearly identify stale ties. Renamed from `events_90d` at
   *  D-136 P3 follow-up. */
  events_window: number;
  /** Top co-attendees by event-pair count, sorted DESC then
   *  alphabetical. Capped at 10 entries — recipes that need the long
   *  tail can always read the underlying calendar collection.
   *  Excludes the source contact themselves. */
  top_co_attendees: ReadonlyArray<AttendeeCoOccurrence>;
  /** Epoch-ms of the most recent event involving the source contact
   *  (organizer or attendee), or `null` when none exist. */
  last_event_at: number | null;
  /** `ctx.now()` when the row was computed. */
  computed_at: number;
  /** D-136 §A.10 — aggregate window the row was computed against,
   *  in milliseconds. Mirrors the topic's registry
   *  `aggregate_window_ms` default (default 90d). */
  window_ms: number;
}

const isAttendeeCoOccurrence = (v: unknown): boolean => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return (
    isString(obj.email) &&
    isNumber(obj.count) &&
    isOptionalString(obj.name) &&
    isOptionalString(obj.entity)
  );
};

const isAttendeeCoOccurrenceArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every(isAttendeeCoOccurrence);

const AttendeePatternsSchema = objectShape<AttendeePatternsValue>({
  name: isOptionalString,
  entity: isOptionalString,
  events_total: isNumber,
  events_window: isNumber,
  top_co_attendees: isAttendeeCoOccurrenceArray,
  last_event_at: isNumberOrNull,
  computed_at: isNumber,
  window_ms: isNumber,
});

// `meeting_frequency` (A.9 of the launch sequence) closes the
// deterministic-contact-aggregate quartet. Calendar-only `aggregate`
// policy keyed on the contact's canonical email; surfaces the rolling
// per-week / per-month meeting cadence with this contact plus a trend
// comparing recent (last 30d) rate against baseline (30-90d ago) rate.
// Recipes use it as a leading indicator for projects ramping up
// ("trend: accelerating") or cooling down ("trend: decelerating").
//
// Window choice: 30d for the recent rate (to align with the `per_week`
// surface — a 30d window divides cleanly into ≈ 4.286 weeks), 90d for
// the wider context (catches monthly + most quarterly cycles, same
// rationale as `attendee_patterns`). The trend's baseline window is
// 30-90d (i.e. events_90d - events_30d).

export interface MeetingFrequencyValue {
  /** Resolved subject-contact name (denormalized from the contacts
   *  directory at producer-run time). Harvest from
   *  internal benchmarks v12a tuning. Optional during the
   *  producer-shape harvest. */
  name?: string;
  /** Subject-contact REF<contacts> identifier (today: canonical email).
   *  Forward-aligned with the contact-identifier-expansion follow-on.
   *  Optional during the harvest. */
  entity?: string;
  /** Total events involving the source contact across all time
   *  (organizer or attendee). */
  events_total: number;
  /** Events involving the contact in the short trailing window (the
   *  topic's primary `aggregate_window_ms`; default 30d). Renamed
   *  from `events_30d` at D-136 P3 follow-up — numerator for
   *  `per_week_window_short` + the recent half of the trend
   *  comparison. */
  events_window_short: number;
  /** Events involving the contact in the long trailing window (3×
   *  the short window; default 90d). Renamed from `events_90d` at
   *  D-136 P3 follow-up — numerator for `per_month_window_long` +
   *  the source for the trend's baseline (long − short). */
  events_window_long: number;
  /** Average meetings per week over the short window. Renamed from
   *  `per_week_30d` at D-136 P3 follow-up. */
  per_week_window_short: number;
  /** Average meetings per month over the long window. Renamed from
   *  `per_month_90d` at D-136 P3 follow-up. */
  per_month_window_long: number;
  /** Trend over the long window. `'accelerating'` when the recent
   *  (short-window) rate is ≥ 1.5× the baseline rate (long-window
   *  events minus short-window events); `'decelerating'` when ≤ 0.5×;
   *  `'stable'` otherwise. `null` when the combined sample is too
   *  small (fewer than 2 events across both windows) for a
   *  meaningful comparison — recipes treat null as "not enough
   *  signal yet" rather than "stable". */
  trend: 'accelerating' | 'stable' | 'decelerating' | null;
  /** Epoch-ms of the most recent event involving the source contact,
   *  or `null` when none exist. */
  last_event_at: number | null;
  /** `ctx.now()` when the row was computed. Recipes read this to
   *  gauge staleness of the rolling-window figures (recompute_cadence
   *  is `7d`). */
  computed_at: number;
  /** D-136 §A.10 — short aggregate window the row was computed
   *  against, in milliseconds. Mirrors the topic's registry
   *  `aggregate_window_ms` default (default 30d). The long window is
   *  derived as `3 * window_ms` in producer logic. */
  window_ms: number;
}

const isMeetingFrequencyTrend = (v: unknown): boolean =>
  v === null || v === 'accelerating' || v === 'stable' || v === 'decelerating';

const MeetingFrequencySchema = objectShape<MeetingFrequencyValue>({
  name: isOptionalString,
  entity: isOptionalString,
  events_total: isNumber,
  events_window_short: isNumber,
  events_window_long: isNumber,
  per_week_window_short: isNumber,
  per_month_window_long: isNumber,
  trend: isMeetingFrequencyTrend,
  last_event_at: isNumberOrNull,
  computed_at: isNumber,
  window_ms: isNumber,
});

// `company` (A.10 of the launch sequence) is the first AI-driven
// contact-scope housekeeping topic + the first signature-parse
// producer. `dependent` policy keyed on the contact's canonical email;
// derives an org affiliation by combining a deterministic email-domain
// signal (always available) with optional AI signature parsing of the
// most recent inbound mail body. The producer always emits a row for
// non-empty contacts — `domain` is the load-bearing field; `company_name`
// graduates from `null` (free-mail) → fallback (domain-only) → AI-parsed
// (signature) as more signal becomes available.
//
// `confidence` is a graded number recipes filter on directly:
//   - `0`         — free-mail provider (gmail, yahoo, …); no business signal
//   - `~0.4`      — domain-only fallback (no body / no signature in body)
//   - `~0.85`     — AI-parsed from a signature block on a recent message
// `emits_confidence: true` opts the topic into D-133 drift detection;
// once 100 baseline samples accumulate, PSI reports flag silent
// regressions in signature-parse quality.

export interface CompanyValue {
  /** Resolved subject-contact name (denormalized from the contacts
   *  directory at producer-run time). Harvest phase 1b. Optional. */
  name?: string;
  /** Subject-contact REF<contacts> identifier (today: canonical email).
   *  Optional during the producer-shape harvest. */
  entity?: string;
  /** Domain extracted from the contact's email — always present so
   *  recipes have something to read even when no company name was
   *  inferable. For `alice@gmail.com` this is `gmail.com`. */
  domain: string;
  /** Inferred organisation name. `null` when the domain is a free-mail
   *  provider OR when neither AI signature parse nor deterministic
   *  derivation produced a usable name. Bounded to 100 chars at the
   *  producer to keep notification payloads small. */
  company_name: string | null;
  /** How `company_name` was derived. `'signature_parse'` when AI
   *  successfully extracted an org from a recent body; `'domain_only'`
   *  for the deterministic fallback (or free-mail providers with no
   *  business signal). Recipes can require `'signature_parse'` to
   *  bias toward higher-confidence signal. */
  source: 'signature_parse' | 'domain_only';
  /** `'free_mail'` for known consumer providers (gmail / yahoo / …);
   *  `'business'` otherwise. Recipes use this to skip free-mail in
   *  org-grouping passes without a domain-list of their own. */
  domain_category: 'free_mail' | 'business';
  /** Free-form one-sentence explanation of the inference. Surfaces in
   *  the Memory tab + audit feeds; not parsed by recipes. */
  reasoning: string;
  /** `ctx.now()` when the row was computed. Recipes read this to
   *  gauge staleness; the cascade engine re-runs the producer on
   *  contact-record changes (new mail flips `last_interaction` →
   *  contact hash flips → harness re-derives). */
  computed_at: number;
}

const isCompanySource = (v: unknown): boolean =>
  v === 'signature_parse' || v === 'domain_only';
const isCompanyDomainCategory = (v: unknown): boolean =>
  v === 'free_mail' || v === 'business';
const isStringOrNull = (v: unknown): boolean =>
  v === null || typeof v === 'string';

const CompanySchema = objectShape<CompanyValue>({
  name: isOptionalString,
  entity: isOptionalString,
  domain: isString,
  company_name: isStringOrNull,
  source: isCompanySource,
  domain_category: isCompanyDomainCategory,
  reasoning: isString,
  computed_at: isNumber,
});

// `role` (A.11 of the launch sequence) is the second AI-driven
// contact-scope housekeeping topic + the second signature-parse
// producer (after `company` A.10). `dependent` policy keyed on the
// contact's canonical email; pure-AI surface — unlike `company`,
// there's no deterministic signal in the contact record itself, so
// the producer returns null when no body / no signature is available
// (no row written, vs `company` which always emits because the
// domain itself is signal).
//
// Output shape splits into two facets:
//
//   - `title`     — free-form string parsed by `ai-extract` from the
//                   signature block. ≤ 100 chars after trim.
//   - `category`  — closed-set bucket derived deterministically from
//                   the title via priority-ordered keyword matching
//                   (NOT a separate LLM call). Recipes filter on this
//                   for "all engineers in this domain", "all execs
//                   across the warehouse", etc.
//
// Why deterministic categorization instead of `ai-classify` (which
// would parallel `purpose`'s pattern): saves a second LLM round-trip
// per contact + guarantees closed-set membership at zero token cost.
// Title-to-category is a thin keyword pass; recipes that need richer
// matching can read the raw `title` field directly. The downside —
// keyword list needs maintenance — is preferable to per-record token
// spend for what's a fundamentally categorization-of-a-string task.
//
// Categorization priority order (executive first, function second)
// ensures C-suite + leadership tier wins over function ("CTO" →
// `executive`, not `engineering`; "VP of Sales" → `executive`, not
// `sales`).

export const ROLE_CATEGORIES = [
  'executive',
  'engineering',
  'product',
  'sales',
  'marketing',
  'operations',
  'support',
  'research',
  'other',
] as const;

export type RoleCategory = typeof ROLE_CATEGORIES[number];

const ROLE_CATEGORY_SET = new Set<string>(ROLE_CATEGORIES);

export interface RoleValue {
  /** Resolved subject-contact name (denormalized from the contacts
   *  directory at producer-run time). Harvest phase 1b. Optional. */
  name?: string;
  /** Subject-contact REF<contacts> identifier (today: canonical email).
   *  Optional during the producer-shape harvest. */
  entity?: string;
  /** Free-form job title parsed from the contact's signature.
   *  Bounded to 100 chars at the producer to keep payloads small. */
  title: string;
  /** Closed-set category derived from `title` via deterministic
   *  keyword matching. `'other'` when no keyword matches — recipes
   *  that need finer matching read `title` directly. */
  category: RoleCategory;
  /** Free-form one-sentence explanation. Surfaces in the Memory tab
   *  + audit feeds; not parsed by recipes. */
  reasoning: string;
  /** `ctx.now()` when the row was computed. */
  computed_at: number;
}

const isRoleCategory = (v: unknown): boolean =>
  typeof v === 'string' && ROLE_CATEGORY_SET.has(v);

const RoleSchema = objectShape<RoleValue>({
  name: isOptionalString,
  entity: isOptionalString,
  title: isString,
  category: isRoleCategory,
  reasoning: isString,
  computed_at: isNumber,
});

// `preparation_notes` (A.12 of the launch sequence) is the first
// calendar-scope housekeeping topic + the first calendar-scope AI
// producer. `dependent` policy keyed on the calendar-event record id
// (one row per upcoming event, cascade-deletes when the event is
// removed, cascade-marks-stale when the event is rescheduled or
// attendees change). Distinct from the per-mail `summary` /
// `purpose` / `action_items` triad in two ways:
//
//   1. **Multi-source corpus.** The producer assembles a small corpus
//      from mail rows where any event attendee appears in the
//      from / to / cc fields, then summarises that corpus through
//      `ai-summarize` rather than reading a single body. The walker
//      hash flips on event-level edits (attendees / time / title);
//      mail accumulating between two cycles does NOT re-flip the
//      walker hash by design — Run-Now is the refresh signal until a
//      future per-record TTL knob lands.
//
//   2. **Past-event skip + future-event accept.** The producer
//      returns null for events more than 24h in the past; older
//      events have no prep value and burning tokens on them is pure
//      cost. Future events are computed as the walker visits them;
//      recipes filter `start_at` to the window they care about
//      (e.g. "events in the next 7 days"). Events whose start_at is
//      moved into the past on a re-walk silently lose their row.

export interface PreparationNotesValue {
  /** Concise prep brief — surfaced verbatim in alert recipes /
   *  Memory previews. The producer caps the LLM's `max_length`
   *  request at ~250 words. */
  summary: string;
  /** 3-5 bullet points distilled by the LLM. Recipes render these
   *  inline next to the meeting card; the cap matches `summary`'s
   *  shape. */
  key_points: ReadonlyArray<string>;
  /** Canonical emails of the attendees the producer used to drive
   *  the corpus query. Recipes can compare this against the live
   *  attendee list to detect "prep was generated before so-and-so
   *  was added" without re-running the producer. */
  attendees_considered: ReadonlyArray<string>;
  /** Resolved-name surface for `attendees_considered` (pre-resolved at
   *  producer-run time). Harvest phase 1b. Optional. */
  attendees_considered_resolved?: ReadonlyArray<{ entity: string; name: string }>;
  /** Total characters in the assembled corpus (post-truncation,
   *  pre-LLM). Surfaces in the audit feed as a transparency signal
   *  + lets recipes detect "prep was generated from very thin
   *  signal" (low corpus size → low confidence inference). */
  corpus_size: number;
  /** `ctx.now()` when the row was computed. */
  computed_at: number;
}

const PreparationNotesSchema = objectShape<PreparationNotesValue>({
  summary: isString,
  key_points: isStringArray,
  attendees_considered: isStringArray,
  attendees_considered_resolved: isContactsResolvedArray,
  corpus_size: isNumber,
  computed_at: isNumber,
});

// `related_threads` (A.13 of the launch sequence) is the second
// calendar-scope housekeeping topic + an aggregate-with-AI-tie-break
// producer. `dependent` policy keyed on the calendar-event record id
// (one row per event; cascade-deletes on event removal; cascade-marks-
// stale on attendee / time / title edits via the standard
// `hashCalendarRecord`).
//
// Different shape from `preparation_notes`:
//
//   1. **Output is a list of mail thread ids**, not a free-text
//      brief. Recipes consume `data.enrichment.related_threads.<id>
//      .threads[]` and call `mail-thread-reader` per thread to pull
//      the conversation history into a meeting brief — clean
//      composition rather than a single LLM-generated summary.
//
//   2. **Deterministic candidate generation, AI tie-break.** The
//      producer walks `collection_mail_*` tables for messages where
//      any attendee is in `from`/`to`/`cc`, groups by `thread_id`,
//      ranks candidates by recency × overlap, and either marks them
//      'high' deterministically (full attendee coverage) or sends
//      them to a single `ai-extract` call that grades each as
//      'high' / 'medium' / 'low' / 'unrelated'. Threads graded
//      `unrelated` are dropped. The `ai_invoked` flag tells consumers
//      whether the result reflects pure-deterministic signal or an
//      LLM tie-break.

export type RelatedThreadRelevance = 'high' | 'medium' | 'low';

const RELATED_THREAD_RELEVANCES = new Set<string>(['high', 'medium', 'low']);

const isRelatedThreadRelevance = (v: unknown): boolean =>
  typeof v === 'string' && RELATED_THREAD_RELEVANCES.has(v);

const isRelatedThreadSource = (v: unknown): boolean =>
  v === 'deterministic' || v === 'ai';

export interface RelatedThread {
  /** Thread identifier echoed verbatim from the source mail rows.
   *  Matches the `thread_id` field recipes pass to
   *  `mail-thread-reader`. */
  thread_id: string;
  /** Most-recent message subject in the thread; cached on the
   *  enrichment row so the marketplace / Memory drawer can render a
   *  tooltip without re-reading mail. */
  subject: string;
  /** Unix-ms of the most-recent message in the thread. Recipes sort
   *  threads by recency for the "5 most-recent related threads"
   *  preset. */
  last_message_at: number;
  /** Number of meeting attendees that appear in the thread (in
   *  `from`/`to`/`cc`). Recipes can filter on `overlap_count >= 2`
   *  to require at least two attendees on the thread. */
  overlap_count: number;
  /** Categorical relevance grade. `'high'` is "definitely the same
   *  topic"; `'medium'` is "probably related"; `'low'` is "weak
   *  signal but worth surfacing." `'unrelated'` is filtered out by
   *  the producer before write — recipes never see it. */
  relevance: RelatedThreadRelevance;
  /** `'deterministic'` when the thread was emitted via the full-
   *  attendee-overlap short-circuit (no LLM call); `'ai'` when the
   *  AI tie-break graded it. Lets consumers gauge how much trust to
   *  place in the relevance label. */
  source: 'deterministic' | 'ai';
  /** Free-form one-sentence explanation present when `source: 'ai'`.
   *  Surfaced inline in the meeting brief so users see why each
   *  thread is suggested. Empty / absent for `source:
   *  'deterministic'`. */
  reasoning?: string;
}

export interface RelatedThreadsValue {
  /** Threads the producer surfaced as related, ordered by relevance
   *  desc then `last_message_at` desc. Capped at the producer's
   *  `MAX_RELATED_THREADS` (5 in v1). */
  threads: ReadonlyArray<RelatedThread>;
  /** Total candidate threads the producer found before filtering /
   *  AI tie-break. Surfaces in the audit feed as a transparency
   *  signal — high candidate count + low result count means the AI
   *  pruned aggressively. */
  candidate_count: number;
  /** True iff the AI tie-break path ran for this row (vs. all
   *  threads being emitted via the full-attendee-overlap
   *  deterministic path). */
  ai_invoked: boolean;
  /** `ctx.now()` when the row was computed. */
  computed_at: number;
}

const isRelatedThread = (v: unknown): boolean => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.thread_id !== 'string' || o.thread_id === '') return false;
  if (typeof o.subject !== 'string') return false;
  if (!isNumber(o.last_message_at)) return false;
  if (!isNumber(o.overlap_count)) return false;
  if (!isRelatedThreadRelevance(o.relevance)) return false;
  if (!isRelatedThreadSource(o.source)) return false;
  if (o.reasoning !== undefined && typeof o.reasoning !== 'string') return false;
  return true;
};

const RelatedThreadsSchema: EnrichmentValueValidator<RelatedThreadsValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!Array.isArray(obj.threads) || !(obj.threads as unknown[]).every(isRelatedThread)) {
    issues.push("field 'threads' must be an array of RelatedThread");
  }
  if (!isNumber(obj.candidate_count)) {
    issues.push("field 'candidate_count' must be a finite number");
  }
  if (typeof obj.ai_invoked !== 'boolean') {
    issues.push("field 'ai_invoked' must be a boolean");
  }
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as RelatedThreadsValue };
};

// `topic_cluster` (A.14 of the launch sequence) is the first Shape B
// (derived-entity) producer in Phase A. `members_list` policy with
// `members_scope: 'mail'` — each cluster owns a list of mail message
// ids; the cascade engine trims an id from every owning row on
// mail-delete + drops the row when its members list empties.
//
// Different clustering shape from `semantic_cluster` (A.17): topic_cluster
// is heuristic + AI-labelled (no embedding sidecar — `sidecar: 'none'`);
// `semantic_cluster` is embedding-driven (`sidecar: 'vector_index'`).
// They coexist; users see two complementary slices of the mail corpus.
//
// Algorithm shape (full spec on the producer side):
//
//   1. Walk recent mail (`MAIL_LOOKBACK_MS` window, capped at
//      `MAX_MESSAGES_SCANNED`); group by `thread_id`.
//   2. Per thread, normalise + tokenise subjects → token bag.
//   3. Agglomerative cluster threads by token-bag Jaccard similarity
//      (≥ `JACCARD_THRESHOLD`); keep clusters with ≥
//      `MIN_THREADS_PER_CLUSTER` threads; cap at `MAX_CLUSTERS`.
//   4. Single `ai-extract` call labels every cluster in one batch
//      with `{ cluster_index, topic_name, summary }`.
//   5. Per cluster:
//        * Compute theme signature (sorted top-N tokens hash) → stable
//          `derived_entity_id` (`topic_cluster_<sha1-prefix>`) so re-
//          runs upsert in place rather than churning ids.
//        * Upsert the row.
//   6. Sweep — list current rows; deleteById any not refreshed this
//      cycle (theme no longer present in the corpus).
//
// `confidence` is fixed at `0.75` — lower than the per-record AI
// surfaces (`company` / `role` / `preparation_notes` at `0.85`)
// because the clustering itself is heuristic; AI only labels.
// `emits_confidence: true` opts the topic into D-133 drift detection;
// once 100 baseline samples accumulate, PSI flags label-quality drift.

export interface TopicCluster {
  /** Short topic name the AI assigned to this cluster. ≤ 40 chars
   *  after producer-side trim; surfaces in the marketplace pack /
   *  Memory drawer. */
  topic_name: string;
  /** One-sentence AI description of what the cluster is about.
   *  Recipes render this as a tooltip / sub-label. */
  summary: string;
  /** Mail message ids belonging to this cluster — the field the
   *  cascade engine trims via `members_list` policy on
   *  mail-source-delete. Empty lists never persist (the producer
   *  drops a cluster with < `MIN_THREADS_PER_CLUSTER` threads before
   *  emit). */
  members: ReadonlyArray<string>;
  /** Distinct mail thread ids represented by `members`. Lets recipes
   *  drive a thread-level brief without re-querying mail. */
  thread_ids: ReadonlyArray<string>;
  /** Top normalised-subject tokens (≤ 5) that drove the deterministic
   *  pre-clustering. The `derived_entity_id` hash is derived from a
   *  sorted prefix of this so the id stays stable while the theme
   *  persists across runs. */
  theme_tokens: ReadonlyArray<string>;
  /** Number of threads merged into this cluster. Recipes filter on
   *  `>= 2` to surface only multi-thread topics. */
  thread_count: number;
  /** True iff the AI label step ran for this cluster (always true in
   *  v1; reserved for a future deterministic-only fallback). */
  ai_invoked: boolean;
  /** `ctx.now()` when the cluster was last upserted. Recipes filter
   *  by recency to skip stale clusters between sweeps. */
  computed_at: number;
  /** D-136 §A.10 — aggregate window the row was computed against,
   *  in milliseconds. Mirrors the topic's registry
   *  `aggregate_window_ms` default (default 90d — the producer's
   *  `MAIL_LOOKBACK_MS`). */
  window_ms: number;
}

const TopicClusterSchema: EnrichmentValueValidator<TopicCluster> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof obj.topic_name !== 'string' || obj.topic_name === '') {
    issues.push("field 'topic_name' must be a non-empty string");
  }
  if (typeof obj.summary !== 'string') {
    issues.push("field 'summary' must be a string");
  }
  if (!isStringArray(obj.members) || (obj.members as unknown[]).length === 0) {
    issues.push("field 'members' must be a non-empty array of mail message ids");
  }
  if (!isStringArray(obj.thread_ids) || (obj.thread_ids as unknown[]).length === 0) {
    issues.push("field 'thread_ids' must be a non-empty array of thread ids");
  }
  if (!isStringArray(obj.theme_tokens)) {
    issues.push("field 'theme_tokens' must be an array of strings");
  }
  if (!isNumber(obj.thread_count)) {
    issues.push("field 'thread_count' must be a finite number");
  }
  if (typeof obj.ai_invoked !== 'boolean') {
    issues.push("field 'ai_invoked' must be a boolean");
  }
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (!isNumber(obj.window_ms)) issues.push("field 'window_ms' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as TopicCluster };
};

// `working_group` (A.15 of the launch sequence) is the second Shape B
// (derived-entity) housekeeping producer + first deterministic Shape B.
// `members_list` policy with `members_scope: 'calendar'` — each working
// group owns the list of calendar event ids that recurringly clustered
// the same set of attendees; cascade engine trims those ids on
// calendar-source-delete. The contact list itself lives on the row's
// `contacts` field (not the cascade-watched member list).
//
// Different from `topic_cluster` (A.14):
//   - Source = calendar (not mail). Recurring meetings, not subject themes.
//   - Deterministic — no AI surface. Pure attendee-set aggregation.
//   - `members[]` = event ids; `contacts[]` = attendee emails. The
//     cascade trims events from the evidence base; contacts stay.
//
// Algorithm shape (full spec on the producer side):
//
//   1. Walk recent calendar events (`MAIL_LOOKBACK_MS`-style window;
//      capped at `MAX_EVENTS_SCANNED`). Skip events with fewer than
//      `MIN_ATTENDEES_PER_EVENT` participants — 1-on-1s aren't
//      "working groups." Skip events without `start_at`.
//   2. For each surviving event, canonical-emails the attendee +
//      organizer set; key = sorted(emails).join('\0').
//   3. Group events by key into Map<key, eventList>.
//   4. Keep groups with ≥ `MIN_RECURRENCE_PER_GROUP` events; cap at
//      `MAX_GROUPS` by event count desc + recency desc tiebreak.
//   5. For each group, emit:
//        derived_entity_id = `working_group_<sha1-prefix(key)>`
//        value = { contacts, members, event_count, last_event_at,
//                  first_event_at, computed_at }
//   6. Sweep stale rows whose ids weren't refreshed this cycle.

export interface WorkingGroupValue {
  /** Canonical attendee emails that define this working group, sorted.
   *  Includes the organizer of the recurring meeting series — the
   *  organizer is a member of the group. Contacts stay on the row even
   *  when individual events are deleted; cascade only trims `members`. */
  contacts: ReadonlyArray<string>;
  /** Calendar event ids the producer found supporting this group. Acts
   *  as the `members_list` field — the cascade engine trims an id on
   *  calendar-source-delete. Empty lists never persist (the producer
   *  drops a group below `MIN_RECURRENCE_PER_GROUP` before emit). */
  members: ReadonlyArray<string>;
  /** Resolved-name surface for the group's contacts (pre-resolved via
   *  the contacts directory at producer-run time). Each entry is
   *  `{ entity: REF<contacts>, name: string }` parallel to the
   *  `contacts: string[]` field above. Harvest from
   *  internal benchmarks v6 catalog tuning — lets the agent
   *  identify group members by name without follow-up entity.query
   *  lookups. Optional during the producer-shape harvest.
   *
   *  NOTE: a forward-compat `event_ids` alias for `members` was
   *  scoped out of Phase 1 — the topic's `members_field: 'members'`
   *  on the cascade engine means an `event_ids` array would NOT
   *  receive calendar-source-delete trims and would silently surface
   *  stale ids. Re-add in Phase 2 paired with cascade-engine sync. */
  contacts_resolved?: ReadonlyArray<{ entity: string; name: string }>;
  /** Number of events backing the group (`members.length` at write
   *  time; carried separately so consumers don't have to count). */
  event_count: number;
  /** `start_at` of the most-recent event in `members`. Recipes filter
   *  by recency to skip dormant groups. */
  last_event_at: number;
  /** `start_at` of the oldest event in `members`. Lets recipes derive
   *  cadence as `(last - first) / event_count` without a separate
   *  field. */
  first_event_at: number;
  /** `ctx.now()` when the row was last upserted. */
  computed_at: number;
}

const isStringArrayNonEmpty = (v: unknown): boolean =>
  Array.isArray(v) && v.length > 0 && v.every((item) => typeof item === 'string');

const WorkingGroupSchema: EnrichmentValueValidator<WorkingGroupValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isStringArrayNonEmpty(obj.contacts)) {
    issues.push("field 'contacts' must be a non-empty array of canonical emails");
  }
  if (!isStringArrayNonEmpty(obj.members)) {
    issues.push("field 'members' must be a non-empty array of calendar event ids");
  }
  if (!isNumber(obj.event_count)) issues.push("field 'event_count' must be a finite number");
  if (!isNumber(obj.last_event_at)) issues.push("field 'last_event_at' must be a finite number");
  if (!isNumber(obj.first_event_at)) issues.push("field 'first_event_at' must be a finite number");
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (!isContactsResolvedArray(obj.contacts_resolved)) {
    issues.push("field 'contacts_resolved' must be an array of { entity, name } when present");
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as WorkingGroupValue };
};

// D-131 A.16 — `organization` Shape B value.
//
// Third Shape B (derived-entity) housekeeping producer + second
// deterministic Shape B. `policy: 'independent'` (NOT `members_list`):
// no cascade-watched member array; the producer rebuilds row contents
// from scratch each cycle.
//
// Different from `working_group` (A.15):
//   - Source = contacts table (not calendar). Domain clustering, not
//     attendee-set clustering.
//   - `policy: 'independent'` — no `members_field`, no `members_scope`.
//     The cascade engine never touches these rows; the producer's manual
//     sweep is the sole truth-source.
//   - `contacts[]` is the canonical emails grouped under the domain.
//     There's no parallel `members[]` (members_list array) — the
//     contact list IS the row's evidence base.
//
// Algorithm shape (full spec on the producer side):
//
//   1. Walk the `contacts` table for rows with `last_interaction` within
//      the look-back window; cap at `MAX_CONTACTS_SCANNED`.
//   2. For each contact, parse the email's domain. Skip rows without an
//      `@`. Skip rows whose domain is in `FREE_MAIL_DOMAINS` — gmail /
//      yahoo / etc. aren't "organisations" the user works with.
//   3. Group contacts by domain into Map<domain, contactList>.
//   4. Drop groups with < `MIN_CONTACTS_PER_ORG` contacts; cap at
//      `MAX_ORGS` by contact count desc + `last_interaction` desc tiebreak.
//   5. For each group emit:
//        derived_entity_id = `organization_<sha1-prefix(domain)>`
//        value = { domain, organization_name, contacts, contact_count,
//                  last_interaction_at, first_seen_at, computed_at }
//   6. Sweep stale rows whose ids weren't refreshed this cycle.

export interface OrganizationValue {
  /** Canonical email domain that defines this organisation
   *  (e.g. `acme.com`). Lowercased; the post-`@` portion of every
   *  contact's email. */
  domain: string;
  /** Human-readable name derived from the domain — `acme-corp.com` →
   *  `Acme Corp`, `nyt.com` → `Nyt`. Mirrors `company.ts`'s
   *  `domainToCompanyName` derivation. Null when the domain carries no
   *  derivable name (numeric-only labels). */
  organization_name: string | null;
  /** Canonical contact emails grouped under this domain, sorted. The
   *  evidence base for the row — there's no separate `members[]` array
   *  because the policy is `independent`, not `members_list`. */
  contacts: ReadonlyArray<string>;
  /** Resolved-name surface for the org's contacts (pre-resolved via
   *  the contacts directory at producer-run time). Each entry is
   *  `{ entity: REF<contacts>, name: string }` parallel to the
   *  `contacts: string[]` field above. Harvest from
   *  internal benchmarks v8 catalog tuning where the bench
   *  showed the v7 retirement experiment regressed because the agent
   *  declines to synthesize company names + member names from raw
   *  emails. Optional during the producer-shape harvest. */
  contacts_resolved?: ReadonlyArray<{ entity: string; name: string }>;
  /** Number of contacts backing the organisation (`contacts.length` at
   *  write time; carried separately so consumers don't have to count). */
  contact_count: number;
  /** Most-recent `last_interaction` across the contacts in this org.
   *  Recipes filter by recency to skip dormant orgs. */
  last_interaction_at: number;
  /** Oldest `first_seen` across the contacts in this org. Lets recipes
   *  compute relationship age without a separate field. */
  first_seen_at: number;
  /** `ctx.now()` when the row was last upserted. */
  computed_at: number;
}

const OrganizationSchema: EnrichmentValueValidator<OrganizationValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof obj.domain !== 'string' || obj.domain.length === 0) {
    issues.push("field 'domain' must be a non-empty string");
  }
  if (!isStringOrNull(obj.organization_name)) {
    issues.push("field 'organization_name' must be a string or null");
  }
  if (!isStringArrayNonEmpty(obj.contacts)) {
    issues.push("field 'contacts' must be a non-empty array of canonical emails");
  }
  if (!isNumber(obj.contact_count)) issues.push("field 'contact_count' must be a finite number");
  if (!isNumber(obj.last_interaction_at)) {
    issues.push("field 'last_interaction_at' must be a finite number");
  }
  if (!isNumber(obj.first_seen_at)) issues.push("field 'first_seen_at' must be a finite number");
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (!isContactsResolvedArray(obj.contacts_resolved)) {
    issues.push("field 'contacts_resolved' must be an array of { entity, name } when present");
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as OrganizationValue };
};

// D-131 A.17 — `semantic_cluster` Shape B value.
//
// Fourth Shape B (derived-entity) housekeeping producer + first
// `vector_index` sidecar consumer. `members_list` policy with
// `members_scope: 'mail'` — each cluster owns the list of mail target_ids
// that grouped together by embedding similarity; cascade engine trims
// those ids on mail-source-delete via the `members_list` policy.
//
// Different from `topic_cluster` (A.14):
//   - Clustering signal = pre-computed embeddings from A.3, not subject
//     tokens. Same-meaning mails with different vocabularies still
//     cluster — that's the point of "semantic" vs "topic."
//   - No AI call inside this producer — A.3 already produced the
//     vectors. Pure cosine-similarity agglomerative clustering.
//   - `sidecar: 'vector_index'` — cluster centroid persists alongside
//     the row; future similarity-search recipes match query vectors
//     against centroid vectors to find related clusters.
//
// Algorithm shape (full spec on the producer side):
//
//   1. List rows where `topic = 'embedding'` (Shape A, scope: 'mail');
//      join with `data_enrichment_vector_index` for the float buffers.
//   2. Group by `value.model` — only same-model vectors are comparable
//      (different embedding spaces have different dimensions / scales).
//      Process the largest model group; minor-model rows are silently
//      skipped this cycle.
//   3. Agglomerative cluster on cosine similarity threshold
//      (`COSINE_THRESHOLD = 0.80`); start each mail as its own cluster,
//      merge highest-similarity pair until none meet threshold.
//   4. Drop clusters with < `MIN_MAILS_PER_CLUSTER = 3`. Cap at
//      `MAX_CLUSTERS = 15` by member count desc.
//   5. For each surviving cluster:
//        derived_entity_id = `semantic_cluster_<sha1-prefix(sorted_member_ids)>`
//        value = { members, member_count, model, avg_intra_similarity,
//                  last_ingested_at, computed_at }
//        sidecar_vector = mean centroid as Float32 buffer
//   6. Sweep stale rows whose ids weren't refreshed this cycle.

export interface SemanticClusterValue {
  /** Mail target_ids that belong to this cluster, sorted. Cascade-watched
   *  via `members_list` policy on mail-source-delete. */
  members: ReadonlyArray<string>;
  /** Number of mails in the cluster (`members.length` at write time;
   *  carried separately so consumers don't have to count). */
  member_count: number;
  /** Embedding model id used to compute the vectors. Recipes filter on
   *  this to know which cohort the cluster came from — only same-model
   *  clusters are directly comparable. */
  model: string;
  /** Average pairwise cosine similarity within the cluster. Proxy for
   *  cluster "tightness" — higher = more semantically uniform. Range
   *  ~[`COSINE_THRESHOLD`, 1.0] since the threshold is the floor for
   *  any pair to merge. */
  avg_intra_similarity: number;
  /** Most-recent `ingested_at` across the cluster's embedding rows.
   *  Used as a recency hint; not the underlying mail's `received_at`
   *  (which would require a per-row mail-table join). */
  last_ingested_at: number;
  /** `ctx.now()` when the row was last upserted. */
  computed_at: number;
}

const SemanticClusterSchema: EnrichmentValueValidator<SemanticClusterValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isStringArrayNonEmpty(obj.members)) {
    issues.push("field 'members' must be a non-empty array of mail ids");
  }
  if (!isNumber(obj.member_count)) issues.push("field 'member_count' must be a finite number");
  if (typeof obj.model !== 'string' || obj.model.length === 0) {
    issues.push("field 'model' must be a non-empty string");
  }
  if (!isNumber(obj.avg_intra_similarity)) {
    issues.push("field 'avg_intra_similarity' must be a finite number");
  }
  if (!isNumber(obj.last_ingested_at)) {
    issues.push("field 'last_ingested_at' must be a finite number");
  }
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as SemanticClusterValue };
};

// D-133 — confidence drift signal value validator.
const isDriftSeverity = (v: unknown): boolean =>
  v === 'none' || v === 'moderate' || v === 'significant';

const isDriftWindow = (v: unknown): boolean => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return isNumber(o.start_at) && isNumber(o.end_at) && isNumber(o.sample_count);
};

const isNumberArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every(isNumber);

const ConfidenceDriftSignalSchema: EnrichmentValueValidator = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof obj.source_topic !== 'string' || obj.source_topic === '') {
    issues.push("field 'source_topic' must be a non-empty string");
  }
  if (!isNumber(obj.psi)) issues.push("field 'psi' must be a finite number");
  if (!isDriftSeverity(obj.severity)) {
    issues.push("field 'severity' must be one of 'none' | 'moderate' | 'significant'");
  }
  if (!isDriftWindow(obj.baseline_window)) {
    issues.push("field 'baseline_window' must be { start_at, end_at, sample_count }");
  }
  if (!isDriftWindow(obj.recent_window)) {
    issues.push("field 'recent_window' must be { start_at, end_at, sample_count }");
  }
  if (!isNumberArray(obj.baseline_distribution)) {
    issues.push("field 'baseline_distribution' must be an array of numbers");
  }
  if (!isNumberArray(obj.recent_distribution)) {
    issues.push("field 'recent_distribution' must be an array of numbers");
  }
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (obj.dismissed_at !== undefined && !isNumber(obj.dismissed_at)) {
    issues.push("field 'dismissed_at' must be a finite number when present");
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj };
};

// D-131 A.18 — `connection_health_trend` Shape A value.
//
// First connection-scope housekeeping producer. Aggregates audit
// activities for each enrolled connection record over a rolling
// window into a per-record health rollup keyed on the connection
// `name` under one of the three `connection.<kind>` scopes.
//
// Shape choices:
//   - `error_rate` is `0` (not `null`) when `call_count == 0` so
//     recipes can `greater 0.1`-gate without first checking for a
//     zero denominator.
//   - `latency_p50_ms` / `latency_p95_ms` are `null` below the
//     producer's per-percentile sample-count floors. Same null-or-
//     finite contract `reply_patterns` uses; recipes `is_null`-gate
//     to skip low-confidence percentiles.
//   - `last_failure` carries `error_code` + `error_message` from the
//     most recent failed call in the window, or `null` when no error.
//     Recipes render the cause inline so the user sees what broke
//     without re-opening the audit log.
//   - `window_ms` echoes the producer's rolling window so recipes
//     reading the value know the time horizon without a hardcode.

export interface ConnectionHealthTrendValue {
  /** Total audit-activity rows folded into this rollup
   *  (calls in window for `(kind, name)`). */
  call_count: number;
  /** Subset of `call_count` whose `status === 'error'`. */
  error_count: number;
  /** `error_count / call_count`; `0` when `call_count === 0` so
   *  recipes can compare against a numeric threshold without first
   *  null-checking. */
  error_rate: number;
  /** Median (p50) `duration_ms` over the window. `null` when the
   *  sample count is below the producer's p50 floor (`5`). */
  latency_p50_ms: number | null;
  /** 95th-percentile `duration_ms` over the window. `null` when the
   *  sample count is below the producer's p95 floor (`20`); same
   *  threshold convention `reply_patterns` uses. */
  latency_p95_ms: number | null;
  /** Epoch-ms of the most recent call (any status), or `null` when
   *  no calls in window. Recipes use this to detect connections that
   *  have gone idle. */
  last_call_at: number | null;
  /** Most recent failed call in the window. `error_code` /
   *  `error_message` carry the failure cause from
   *  `ConnectionAuditDetail.error`; both default to `''` when the
   *  emitter wrote a status='error' row without an error block.
   *  `null` when no failure in window. */
  last_failure: {
    ts: number;
    error_code: string;
    error_message: string;
  } | null;
  /** Rolling window length in ms — echoes the producer's
   *  `CONNECTION_HEALTH_TREND_WINDOW_MS`. Surfaces in the value so
   *  recipes know the time horizon without a hardcode. */
  window_ms: number;
  /** `ctx.now()` when the row was computed. */
  computed_at: number;
}

const isConnectionHealthTrendLastFailure = (v: unknown): boolean => {
  if (v === null) return true;
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return isNumber(obj.ts) && isString(obj.error_code) && isString(obj.error_message);
};

const ConnectionHealthTrendSchema: EnrichmentValueValidator<ConnectionHealthTrendValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.call_count)) issues.push("field 'call_count' must be a finite number");
  if (!isNumber(obj.error_count)) issues.push("field 'error_count' must be a finite number");
  if (!isNumber(obj.error_rate)) issues.push("field 'error_rate' must be a finite number");
  if (!isNumberOrNull(obj.latency_p50_ms)) {
    issues.push("field 'latency_p50_ms' must be a finite number or null");
  }
  if (!isNumberOrNull(obj.latency_p95_ms)) {
    issues.push("field 'latency_p95_ms' must be a finite number or null");
  }
  if (!isNumberOrNull(obj.last_call_at)) {
    issues.push("field 'last_call_at' must be a finite number or null");
  }
  if (!isConnectionHealthTrendLastFailure(obj.last_failure)) {
    issues.push("field 'last_failure' must be { ts, error_code, error_message } or null");
  }
  if (!isNumber(obj.window_ms)) issues.push("field 'window_ms' must be a finite number");
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as ConnectionHealthTrendValue };
};

// D-131 A.19 — `connection_last_used_pattern` Shape A value.
//
// Second connection-scope housekeeping producer. Aggregates audit
// activities per `(kind, name)` over a rolling window into a per-record
// usage rollup: total call count, last-used timestamp, per-recipe
// breakout, distinct-recipe count, unattributed (direct-rpc) call
// count, and a 24-element UTC hourly histogram for the "what hours
// does this connection get used?" signal.
//
// Shape choices:
//   - `last_used_at` is `null` when the window holds no calls so the
//     UI can render "never used" inline. When present it is the most
//     recent ts across all callers (recipe-attributed and not).
//   - `recipes[]` is sorted by `call_count` desc, `recipe_id` asc on
//     ties, capped at the producer's `MAX_RECIPES_IN_BREAKOUT` so a
//     pathological caller can't blow up the row size. `distinct_recipes`
//     reports the *true* count even when the array is truncated.
//   - `unattributed_call_count` carries the calls whose audit detail
//     had no `recipe_id` (direct rpc, MCP agent, Settings probe). Sum
//     of `recipes[].call_count` + `unattributed_call_count` equals
//     `call_count` exactly.
//   - `hour_histogram` is always a 24-element array even when the
//     window is empty (each entry `0`), so recipes can index it
//     without first checking length.
//   - `window_ms` echoes the producer's rolling window for recipes
//     that need to qualify the signal without a hardcode.

export interface ConnectionLastUsedPatternRecipeBreakout {
  /** Recipe id from the audit row's `detail.recipe_id`. */
  recipe_id: string;
  /** Calls attributed to this recipe in the window. */
  call_count: number;
  /** Most recent attributed-to-this-recipe call ts. */
  last_used_at: number;
}

export interface ConnectionLastUsedPatternValue {
  /** Total audit-activity rows folded into this rollup
   *  (calls in window for `(kind, name)`, recipe-attributed +
   *  unattributed). */
  call_count: number;
  /** Epoch-ms of the most recent call (any caller), or `null` when no
   *  calls in window. Recipes use this to detect connections that have
   *  gone idle ("last used 32 days ago" → suggest retiring). */
  last_used_at: number | null;
  /** Per-recipe usage breakout. Sorted by `call_count` desc, then
   *  `recipe_id` asc on ties; capped at the producer's
   *  `MAX_RECIPES_IN_BREAKOUT` to bound the row size. The full
   *  distinct count lives in `distinct_recipes` so the truncation is
   *  explicit. */
  recipes: ConnectionLastUsedPatternRecipeBreakout[];
  /** True count of distinct recipes that called this connection in
   *  the window — independent of the `recipes[]` truncation. */
  distinct_recipes: number;
  /** Calls whose audit row carried no `recipe_id` attribution
   *  (direct rpc — Settings probe, MCP agent, raw test calls). Sum of
   *  `recipes[].call_count` (after un-truncation) plus this equals
   *  `call_count`. */
  unattributed_call_count: number;
  /** 24-element UTC hourly histogram. `hour_histogram[h]` is the
   *  number of calls whose ts fell in hour `h` (UTC). Always 24
   *  elements even on empty windows. */
  hour_histogram: number[];
  /** Rolling window length in ms — echoes the producer's
   *  `CONNECTION_LAST_USED_PATTERN_WINDOW_MS`. Surfaces in the value
   *  so recipes know the time horizon without a hardcode. */
  window_ms: number;
  /** `ctx.now()` when the row was computed. */
  computed_at: number;
}

const isConnectionLastUsedPatternRecipe = (v: unknown): boolean => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return isString(obj.recipe_id) && isNumber(obj.call_count) && isNumber(obj.last_used_at);
};

const isConnectionLastUsedPatternRecipeArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every(isConnectionLastUsedPatternRecipe);

const isHourHistogram = (v: unknown): boolean =>
  Array.isArray(v) && v.length === 24 && v.every(isNumber);

const ConnectionLastUsedPatternSchema: EnrichmentValueValidator<ConnectionLastUsedPatternValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.call_count)) issues.push("field 'call_count' must be a finite number");
  if (!isNumberOrNull(obj.last_used_at)) {
    issues.push("field 'last_used_at' must be a finite number or null");
  }
  if (!isConnectionLastUsedPatternRecipeArray(obj.recipes)) {
    issues.push("field 'recipes' must be an array of { recipe_id, call_count, last_used_at }");
  }
  if (!isNumber(obj.distinct_recipes)) {
    issues.push("field 'distinct_recipes' must be a finite number");
  }
  if (!isNumber(obj.unattributed_call_count)) {
    issues.push("field 'unattributed_call_count' must be a finite number");
  }
  if (!isHourHistogram(obj.hour_histogram)) {
    issues.push("field 'hour_histogram' must be a 24-element array of finite numbers");
  }
  if (!isNumber(obj.window_ms)) issues.push("field 'window_ms' must be a finite number");
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as ConnectionLastUsedPatternValue };
};

// D-131 A.20 — `connection_optimal_batch_size` Shape A value.
//
// Third + final connection-scope housekeeping producer. Closes the
// connection-scope trio (alongside A.18 health + A.19 last-used) and
// completes Phase A. Same standalone-task multi-scope shape but
// excludes `notification` kind — the registry's `valid_scopes` only
// accepts api + mcp (notification connections are fire-and-forget,
// no batching to tune).
//
// Aggregates audit activities per `(kind, name)` over a 7d window
// and infers a recommended payload size in bytes. The signal is
// inherently inferential — audit rows carry per-call `bytes_out`
// + `duration_ms` + `status`, not "batch size" directly. The
// producer infers the recommendation as the p75 payload of
// successful calls whose duration stayed under 2× the global median.
//
// Shape choices:
//   - Every percentile field is `null` below the producer's sample
//     floor. Same null-or-finite contract A.18 + `reply_patterns`
//     use; recipes `is_null`-gate cleanly.
//   - `bytes_coverage` reports the fraction of calls where the
//     adapter emitted `bytes_out`. Some adapters (MCP, certain HTTP
//     wrappers) don't emit bytes accounting at all. Recipes can
//     `greater 0.5`-gate before trusting the recommendation.
//   - `recommended_max_payload_bytes` is `null` when the sample is
//     too small OR when bytes coverage is too low to infer reliably.
//     The two paths to null are folded into the same field so
//     recipes only need one gate.
//   - `window_ms` echoes the producer's rolling window so recipes
//     know the time horizon without a hardcode.

export interface ConnectionOptimalBatchSizeValue {
  /** Total audit-activity rows folded into the inference (calls in
   *  window for `(kind, name)`, regardless of whether `bytes_out`
   *  was emitted). */
  sample_count: number;
  /** Median (p50) `duration_ms` over the window. `null` when the
   *  sample count is below the producer's p50 floor. */
  median_duration_ms: number | null;
  /** 95th-percentile `duration_ms` over the window. `null` when the
   *  sample count is below the producer's p95 floor. */
  p95_duration_ms: number | null;
  /** Median observed `bytes_out` across calls that emitted the field.
   *  `null` when too few calls emitted bytes_out to infer. Callers
   *  should also check `bytes_coverage` before trusting this. */
  median_payload_bytes: number | null;
  /** P95 observed `bytes_out`. Same null-discipline as
   *  `median_payload_bytes`. */
  p95_payload_bytes: number | null;
  /** Inferred recommended max payload size in bytes — p75 of
   *  successful calls whose duration stayed under 2× the global
   *  median. `null` when the sample is below floor OR when no
   *  successful-and-fast call had `bytes_out` emitted. Recipes
   *  reading this should also gate on `bytes_coverage`. */
  recommended_max_payload_bytes: number | null;
  /** Fraction (`[0, 1]`) of `sample_count` calls whose audit detail
   *  carried `bytes_out`. `0` when no calls emitted bytes accounting;
   *  `1` when every call did. Always defined (not null). */
  bytes_coverage: number;
  /** Rolling window length in ms — echoes the producer's
   *  `CONNECTION_OPTIMAL_BATCH_SIZE_WINDOW_MS`. */
  window_ms: number;
  /** `ctx.now()` when the row was computed. */
  computed_at: number;
}

const ConnectionOptimalBatchSizeSchema: EnrichmentValueValidator<ConnectionOptimalBatchSizeValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.sample_count)) issues.push("field 'sample_count' must be a finite number");
  if (!isNumberOrNull(obj.median_duration_ms)) {
    issues.push("field 'median_duration_ms' must be a finite number or null");
  }
  if (!isNumberOrNull(obj.p95_duration_ms)) {
    issues.push("field 'p95_duration_ms' must be a finite number or null");
  }
  if (!isNumberOrNull(obj.median_payload_bytes)) {
    issues.push("field 'median_payload_bytes' must be a finite number or null");
  }
  if (!isNumberOrNull(obj.p95_payload_bytes)) {
    issues.push("field 'p95_payload_bytes' must be a finite number or null");
  }
  if (!isNumberOrNull(obj.recommended_max_payload_bytes)) {
    issues.push("field 'recommended_max_payload_bytes' must be a finite number or null");
  }
  if (!isNumber(obj.bytes_coverage)) {
    issues.push("field 'bytes_coverage' must be a finite number");
  }
  if (!isNumber(obj.window_ms)) issues.push("field 'window_ms' must be a finite number");
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as ConnectionOptimalBatchSizeValue };
};

// ────────────────────────────────────────────────────────────────
// D-128 P4 — platform-reference reserved topics
// ────────────────────────────────────────────────────────────────

/** D-128 P4 — `deal_health_score` value shape. AI-derived 0-100
 *  score per CRM deal. Producers ship in D-129+ on the housekeeping
 *  harness; the schema pre-bakes so the validator + lint rule already
 *  recognise refs against `connection.api.<vendor>.<entity>.<id>.deal_health_score`. */
export interface DealHealthScoreValue {
  /** 0-100 health signal — higher is healthier. */
  score: number;
  /** AI-extracted signals contributing to the score (engagement,
   *  stage age, recent activity). String list for renderer + audit. */
  signals: string[];
  /** Free-form rationale — surfaced on Memory tab tooltip + alert
   *  body. AI-generated; recipe authors do not parse this string. */
  reasoning: string;
}

const DealHealthScoreSchema: EnrichmentValueValidator<DealHealthScoreValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.score) || (obj.score as number) < 0 || (obj.score as number) > 100) {
    issues.push("field 'score' must be a finite number in [0, 100]");
  }
  if (!isStringArray(obj.signals)) issues.push("field 'signals' must be string[]");
  if (!isString(obj.reasoning)) issues.push("field 'reasoning' must be a string");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as DealHealthScoreValue };
};

/** D-128 P4 — `deal_velocity_signal` value shape. Deterministic
 *  aggregate over recent vendor activity. */
export type DealVelocity = 'accelerating' | 'stable' | 'stalling';

export interface DealVelocitySignalValue {
  velocity: DealVelocity;
  /** Count of vendor-side activities in the rolling window
   *  (notes / tasks / mail logged on the deal). */
  recent_activity_count: number;
  /** How long the deal has been in its current stage (whole days). */
  days_in_stage: number;
  /** Cursor for the producer — last observed activity timestamp. */
  cursor_at: number;
}

const DEAL_VELOCITY_VALUES: ReadonlySet<DealVelocity> = new Set([
  'accelerating', 'stable', 'stalling',
]);

const DealVelocitySignalSchema: EnrichmentValueValidator<DealVelocitySignalValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof obj.velocity !== 'string'
      || !DEAL_VELOCITY_VALUES.has(obj.velocity as DealVelocity)) {
    issues.push(`field 'velocity' must be one of ${[...DEAL_VELOCITY_VALUES].join(' / ')}`);
  }
  if (!isNumber(obj.recent_activity_count) || (obj.recent_activity_count as number) < 0) {
    issues.push("field 'recent_activity_count' must be a non-negative finite number");
  }
  if (!isNumber(obj.days_in_stage) || (obj.days_in_stage as number) < 0) {
    issues.push("field 'days_in_stage' must be a non-negative finite number");
  }
  if (!isNumber(obj.cursor_at)) issues.push("field 'cursor_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as DealVelocitySignalValue };
};

/** D-128 P4 + D-129 P6 — `engagement_score_per_contact` value shape.
 *  Aggregates mail + calendar + vendor activity per CRM contact. The
 *  `signal_breakdown` triple decomposes the score by source so recipes
 *  can route on which channel is doing the work (e.g. high `hubspot`
 *  but low `local` = the customer's CRM-logged but not engaged on
 *  email); `trajectory` compares the most recent 30d window against the
 *  prior 60d to surface contacts whose engagement is rising or fading. */
export interface EngagementScorePerContactValue {
  /** Resolved subject-contact name (denormalized from the contacts
   *  directory at producer-run time). Harvest phase 1b. Optional. */
  name?: string;
  /** Subject-contact REF<contacts> identifier (today: canonical email).
   *  Optional during the producer-shape harvest. */
  entity?: string;
  /** 0-100 engagement signal — higher is more engaged. */
  score: number;
  /** Last-meaningful-touch unix-ms across all aggregated sources. */
  last_meaningful_touch: number;
  /** Decomposition of `score` by signal source. Each component is in
   *  `[0, 100]` and represents that source's contribution before
   *  normalization. Recipes can read individual components — e.g. flag
   *  contacts with high CRM activity but no local mail/calendar
   *  engagement.
   *
   *  Vendor fields are open (D-192): each row carries ONE key named for
   *  the CRM vendor whose `connection.api.<vendor>.contact` scope owns the
   *  row. The non-owning vendors' keys are omitted rather than zeroed so
   *  consumers can distinguish "no signal" from "vendor not enrolled".
   *  `local` and `recency` are vendor-agnostic and always present. */
  signal_breakdown: {
    /** Score contribution from Recued local mail + calendar — the join
     *  through `data.contact.<email>` to mail/event activity. Always present. */
    local: number;
    /** Score contribution from recency — how recent the last
     *  meaningful touch is. Decays over a rolling window. Always present. */
    recency: number;
    /** Per-vendor score contribution, keyed by the CRM vendor that owns the
     *  row's `connection.api.<vendor>.contact` scope (`hubspot`, `salesforce`,
     *  `pipedrive`, or any pack-declared CRM vendor). Exactly ONE vendor key
     *  is present per row — the owning vendor. Open (`Record<string, number>`)
     *  since D-192, when the closed `hubspot?`/`salesforce?` pair became
     *  registry-driven as the engagement plane opened to pack vendors. */
    [vendor: string]: number | undefined;
  };
  /** Direction of recent engagement vs. baseline. `'rising'` when the
   *  last 30d window's activity ratio against the 30-90d baseline is
   *  ≥ 1.5×; `'falling'` when ≤ 0.5×; `'flat'` otherwise. Mirrors the
   *  `meeting_frequency.trend` shape so recipes can read either topic
   *  with the same semantics. */
  trajectory: 'rising' | 'flat' | 'falling';
  /** Producer cursor — max source modified_at folded so far. */
  cursor_at: number;
}

const ENGAGEMENT_TRAJECTORIES: ReadonlySet<string> = new Set([
  'rising', 'flat', 'falling',
]);

const isEngagementTrajectory = (v: unknown): boolean =>
  typeof v === 'string' && ENGAGEMENT_TRAJECTORIES.has(v);

const isEngagementSignalBreakdown = (v: unknown): boolean => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  if (!isNumber(obj.local)) return false;
  if (!isNumber(obj.recency)) return false;
  // Vendor keys are open (any CRM vendor id — hubspot / salesforce / pipedrive /
  // pack-declared) since D-192, so validate structurally rather than enumerating:
  // every present value (local, recency, and each per-vendor contribution) is a
  // finite number.
  for (const key of Object.keys(obj)) {
    if (!isNumber(obj[key])) return false;
  }
  return true;
};

const EngagementScorePerContactSchema: EnrichmentValueValidator<EngagementScorePerContactValue> =
  (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, issues: ['expected object'] };
    }
    const obj = value as Record<string, unknown>;
    const issues: string[] = [];
    if (!isNumber(obj.score) || (obj.score as number) < 0 || (obj.score as number) > 100) {
      issues.push("field 'score' must be a finite number in [0, 100]");
    }
    if (!isNumber(obj.last_meaningful_touch)) {
      issues.push("field 'last_meaningful_touch' must be a finite number");
    }
    if (!isEngagementSignalBreakdown(obj.signal_breakdown)) {
      issues.push(
        "field 'signal_breakdown' must be { local: number, recency: number, "
          + "hubspot?: number, salesforce?: number }",
      );
    }
    if (!isEngagementTrajectory(obj.trajectory)) {
      issues.push("field 'trajectory' must be one of rising / flat / falling");
    }
    if (!isNumber(obj.cursor_at)) issues.push("field 'cursor_at' must be a finite number");
    if (!isOptionalString(obj.name)) issues.push("field 'name' must be string when present");
    if (!isOptionalString(obj.entity)) issues.push("field 'entity' must be string when present");
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: obj as unknown as EngagementScorePerContactValue };
  };

/** D-139 P1a.1 — `engagement_silence_duration` value shape. Canary
 *  enrichment for the engagement substrate: smallest end-to-end path
 *  from reconciler write → engagement_edges emit → cascade fire →
 *  per-deal aggregate compute. Single-source (HubSpot email at
 *  P1a.1; widens at P1a.2 + P1b), no AI, deterministic.
 *
 *  Producer reads `engagement_edges` for `edge_type='deal'` rows
 *  scoped to the deal; walks each engagement; filters
 *  `event_at IS NOT NULL` AND `lifecycle_state IN ('point_in_time',
 *  'completed')` AND `authorship NOT IN ('crm_automation',
 *  'system_process')` AND `direction = 'inbound'` per § A.9.1; emits
 *  the silence-duration value. */
export interface EngagementSilenceDurationValue {
  /** Days since last meaningful inbound engagement on the deal. */
  days: number;
  /** Unix-ms event_at of the latest inbound engagement contributing
   *  to the calculation. `0` when no qualifying inbound found —
   *  callers compare `days` against their threshold; the producer
   *  emits an honest zero rather than skipping the row. */
  last_inbound_event_at: number;
  /** Producer cursor — max engagement vendor_modified_at folded so
   *  far. Pre-launch zero installs lets the producer carry one
   *  cursor per row. */
  cursor_at: number;
}

const EngagementSilenceDurationSchema: EnrichmentValueValidator<
  EngagementSilenceDurationValue
> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.days) || (obj.days as number) < 0) {
    issues.push("field 'days' must be a non-negative finite number");
  }
  if (!isNumber(obj.last_inbound_event_at)) {
    issues.push("field 'last_inbound_event_at' must be a finite number");
  }
  if (!isNumber(obj.cursor_at)) {
    issues.push("field 'cursor_at' must be a finite number");
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: obj as unknown as EngagementSilenceDurationValue,
  };
};

// ────────────────────────────────────────────────────────────────
// D-139 P3 — Deterministic deal-level enrichments (§ A.9.1)
// ────────────────────────────────────────────────────────────────
//
// Three additional aggregate-policy topics on the engagement
// substrate: `engagement_velocity_signal` + `inbound_outbound_ratio`
// + `last_meaningful_touch`. All three follow the canary's
// (engagement_silence_duration) shape — `policy: 'aggregate'`,
// `aggregates_from` lists per-type engagement scopes, deterministic
// (zero token cost), `producer_kind: 'reactive'`, default trust
// `'auto'`. Producers consume Pass-4 evidence-quality contracts
// (authorship + direction + lifecycle_state + dedupe_confidence)
// declared at substrate level on every `EngagementRow`; consumption
// defaults are baked into the producer algorithm + tested directly.
//
// `valid_scopes` covers HubSpot deal + Salesforce opportunity per
// the Deal Identity Asymmetry Invariant (§ A.5.5) — engagements
// hang off platform-reference target_ids, never the cross-vendor
// `data.crm.deal` lens (which is enrichment-only at D-130 P7).

/** D-139 P3 — `engagement_velocity_signal` trajectory enum. */
export const ENGAGEMENT_VELOCITY_TRAJECTORIES = [
  'accelerating',
  'steady',
  'decaying',
] as const;
export type EngagementVelocityTrajectory =
  (typeof ENGAGEMENT_VELOCITY_TRAJECTORIES)[number];
const ENGAGEMENT_VELOCITY_TRAJECTORY_SET: ReadonlySet<string> = new Set(
  ENGAGEMENT_VELOCITY_TRAJECTORIES,
);
const isEngagementVelocityTrajectory = (v: unknown): boolean =>
  typeof v === 'string' && ENGAGEMENT_VELOCITY_TRAJECTORY_SET.has(v);

/** D-139 P3 — `engagement_velocity_signal` value shape. Touches/week
 *  trajectory comparing the recent (30d) window against the baseline
 *  (30-90d) window. Producer weights `'crm_automation'` +
 *  `'system_process'` rows at 0.25; full-weight `'no_answer'` calls
 *  at 0.25 (attempt counts but at lower contribution). `'failed'` /
 *  `'cancelled'` lifecycle states are excluded. Direction
 *  `'internal'` is excluded (rep-to-rep chatter doesn't count
 *  against external trajectory). Default `dedupe_acceptance:
 *  'exact_only'` — probable-twin pairs counted as separate touches.
 *
 *  `weighted_recent` / `weighted_baseline` are the post-weight
 *  counts the trajectory comparison runs against; `total_recent` /
 *  `total_baseline` are the unweighted raw counts so consumers can
 *  see how much weighting affected the call. */
export interface EngagementVelocitySignalValue {
  /** Trajectory bucket — 'accelerating' / 'steady' / 'decaying'.
   *  Computed via `weighted_recent / max(weighted_baseline_per_30d,
   *  EPSILON)`. */
  trajectory: EngagementVelocityTrajectory;
  /** Weighted touches in the recent (30d) window. Sum of per-row
   *  authorship + lifecycle weights; non-finite never. */
  weighted_recent: number;
  /** Weighted touches in the baseline (30-90d) window. Same shape;
   *  consumer compares `weighted_recent` against
   *  `weighted_baseline / 2` (60d window → 30d-equivalent rate). */
  weighted_baseline: number;
  /** Unweighted raw counts so callers can audit. */
  total_recent: number;
  total_baseline: number;
  /** Producer cursor — max source `vendor_modified_at` folded so far.
   *  Honest zero when no qualifying engagement landed yet. */
  cursor_at: number;
}

const EngagementVelocitySignalSchema: EnrichmentValueValidator<
  EngagementVelocitySignalValue
> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isEngagementVelocityTrajectory(obj.trajectory)) {
    issues.push(
      `field 'trajectory' must be one of ${ENGAGEMENT_VELOCITY_TRAJECTORIES.join(' / ')}`,
    );
  }
  if (!isNumber(obj.weighted_recent) || (obj.weighted_recent as number) < 0) {
    issues.push("field 'weighted_recent' must be a non-negative finite number");
  }
  if (!isNumber(obj.weighted_baseline) || (obj.weighted_baseline as number) < 0) {
    issues.push(
      "field 'weighted_baseline' must be a non-negative finite number",
    );
  }
  if (!isNumber(obj.total_recent) || (obj.total_recent as number) < 0) {
    issues.push("field 'total_recent' must be a non-negative finite number");
  }
  if (!isNumber(obj.total_baseline) || (obj.total_baseline as number) < 0) {
    issues.push("field 'total_baseline' must be a non-negative finite number");
  }
  if (!isNumber(obj.cursor_at)) {
    issues.push("field 'cursor_at' must be a finite number");
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as EngagementVelocitySignalValue };
};

/** D-139 P3 — `inbound_outbound_ratio` bucket enum. */
export const INBOUND_OUTBOUND_BUCKETS = [
  'rep_pushing',
  'mutual',
  'prospect_pulling',
] as const;
export type InboundOutboundBucket =
  (typeof INBOUND_OUTBOUND_BUCKETS)[number];
const INBOUND_OUTBOUND_BUCKET_SET: ReadonlySet<string> = new Set(
  INBOUND_OUTBOUND_BUCKETS,
);
const isInboundOutboundBucket = (v: unknown): boolean =>
  typeof v === 'string' && INBOUND_OUTBOUND_BUCKET_SET.has(v);

/** D-139 P3 — `inbound_outbound_ratio` value shape. Rep effort vs
 *  prospect engagement on the deal. Inbound bucket counts only
 *  prospect-side authorship (`'unknown'` is included; automation +
 *  system_process are excluded); outbound bucket counts only rep
 *  effort (`authorship IN ('user', 'crm_user')`). Internal direction
 *  excluded from both buckets. Lifecycle filter: `'point_in_time'` +
 *  `'completed'` count fully; `'no_answer'` / `'failed'` (HubSpot
 *  email send failures) count for outbound effort only (rep made the
 *  attempt) but not as prospect engagement.
 *
 *  Bucket mapping:
 *    - `'rep_pushing'`     when `outbound > 1.5 × inbound`
 *    - `'prospect_pulling'`when `inbound  > 1.5 × outbound`
 *    - `'mutual'`          otherwise (including both-zero) */
export interface InboundOutboundRatioValue {
  /** Count of inbound engagements meeting the prospect-engagement
   *  filter (direction='inbound' + authorship NOT IN automation /
   *  system_process + lifecycle in evidence states). */
  inbound_count: number;
  /** Count of outbound engagements meeting the rep-effort filter
   *  (direction='outbound' + authorship IN user / crm_user +
   *  lifecycle in evidence + 'no_answer' + 'failed' states). */
  outbound_count: number;
  /** `outbound_count / max(inbound_count, 1)` — rep effort per
   *  prospect response. Unbounded above; `0` when no outbound. */
  ratio: number;
  /** Categorical bucket for recipe gating. */
  bucket: InboundOutboundBucket;
  /** Producer cursor — max source `vendor_modified_at` folded. */
  cursor_at: number;
}

const InboundOutboundRatioSchema: EnrichmentValueValidator<
  InboundOutboundRatioValue
> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.inbound_count) || (obj.inbound_count as number) < 0) {
    issues.push("field 'inbound_count' must be a non-negative finite number");
  }
  if (!isNumber(obj.outbound_count) || (obj.outbound_count as number) < 0) {
    issues.push("field 'outbound_count' must be a non-negative finite number");
  }
  if (!isNumber(obj.ratio) || (obj.ratio as number) < 0) {
    issues.push("field 'ratio' must be a non-negative finite number");
  }
  if (!isInboundOutboundBucket(obj.bucket)) {
    issues.push(
      `field 'bucket' must be one of ${INBOUND_OUTBOUND_BUCKETS.join(' / ')}`,
    );
  }
  if (!isNumber(obj.cursor_at)) {
    issues.push("field 'cursor_at' must be a finite number");
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as InboundOutboundRatioValue };
};

/** D-139 P3 — `last_meaningful_touch` value shape. Most recent
 *  substantive engagement on the deal — filtered against authorship
 *  `'crm_automation'` + `'system_process'` (tracking-pixel opens +
 *  workflow auto-logs are not "meaningful"). Lifecycle filter:
 *  `'point_in_time'` + `'completed'` only — pending tasks +
 *  scheduled meetings + cancelled rows + `'no_answer'` calls +
 *  `'failed'` sends are NOT meaningful touches (the touch hasn't
 *  happened or didn't connect). Direction: any (a meaningful
 *  inbound or outbound counts).
 *
 *  `event_at` is the touch's event-time per § A.3.1 mapping — reads
 *  the substrate's per-entity `event_at` field directly without
 *  re-deriving from `vendor_modified_at`. Honest `0` when no
 *  qualifying touch found (consumers compare against threshold;
 *  producer never skips the row). */
export interface LastMeaningfulTouchValue {
  /** Unix-ms event_at of the most-recent meaningful touch on the
   *  deal. `0` when no qualifying touch found yet. */
  last_touch_at: number;
  /** Vendor of the touch — `null` when `last_touch_at = 0`. D-192 — OPEN vendor
   *  id (was `'hubspot' | 'salesforce'`); carries the engagement row's vendor as
   *  opaque provenance so a pack-declared engagement CRM's touch is recorded. */
  vendor: string | null;
  /** Per-entity name (`'email'` / `'meeting'` / `'note'` / `'call'` /
   *  `'task'` for HubSpot; `'task'` / `'event'` /
   *  `'email_message'` / `'voice_call'` / `'call_history'` for
   *  Salesforce) — `null` when no touch found. */
  entity: string | null;
  /** Authorship of the touch — `null` when no touch found. Recipes
   *  reading the value can gate "last touch was a teammate vs me". */
  authorship: Authorship | null;
  /** Direction of the touch — `null` when no touch found. */
  direction: Direction | null;
  /** Producer cursor — max source `vendor_modified_at` folded. */
  cursor_at: number;
}

const LastMeaningfulTouchSchema: EnrichmentValueValidator<
  LastMeaningfulTouchValue
> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.last_touch_at) || (obj.last_touch_at as number) < 0) {
    issues.push("field 'last_touch_at' must be a non-negative finite number");
  }
  if (obj.vendor !== null && typeof obj.vendor !== 'string') {
    issues.push("field 'vendor' must be a vendor id string or null");
  }
  if (obj.entity !== null && typeof obj.entity !== 'string') {
    issues.push("field 'entity' must be a string or null");
  }
  if (obj.authorship !== null && !AUTHORSHIP_SET.has(obj.authorship as string)) {
    issues.push(
      `field 'authorship' must be a valid Authorship enum or null`,
    );
  }
  if (obj.direction !== null && !DIRECTION_SET.has(obj.direction as string)) {
    issues.push(
      `field 'direction' must be a valid Direction enum or null`,
    );
  }
  if (!isNumber(obj.cursor_at)) {
    issues.push("field 'cursor_at' must be a finite number");
  }
  // last_touch_at = 0 must be paired with all-null fields (no touch
  // yet); a non-zero last_touch_at must carry vendor + entity +
  // authorship + direction populated. The pair guards a class of
  // producer bugs where the touch fields drift out of sync.
  const hasTouch = isNumber(obj.last_touch_at) && (obj.last_touch_at as number) > 0;
  if (hasTouch) {
    if (obj.vendor === null) {
      issues.push("field 'vendor' must be populated when 'last_touch_at' > 0");
    }
    if (obj.entity === null) {
      issues.push("field 'entity' must be populated when 'last_touch_at' > 0");
    }
    if (obj.authorship === null) {
      issues.push("field 'authorship' must be populated when 'last_touch_at' > 0");
    }
    if (obj.direction === null) {
      issues.push("field 'direction' must be populated when 'last_touch_at' > 0");
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as LastMeaningfulTouchValue };
};

// ────────────────────────────────────────────────────────────────
// D-139 P4 — Cross-entity enrichments (§ A.9.2b)
// ────────────────────────────────────────────────────────────────
//
// Six cross-source aggregate-policy topics that fold engagements
// alongside Recued local mail / calendar / CRM record meta. Each
// topic declares cross-source `aggregates_from` (per-type engagement
// scopes ∪ `mail` / `calendar` / vendor record scopes); each producer
// consumes Pass-4 evidence-quality contracts directly off
// `EngagementRow` (authorship + direction + lifecycle_state +
// dedupe_confidence). Trust default `'auto'` per D-132
// (deterministic); pool policy `'free_only'` since they cost zero
// tokens.
//
// Three are deal-scoped (`meeting_to_followup_lag` +
// `out_of_band_engagement`), two are account-scoped
// (`account_engagement_breadth` + `account_reentry_signal`), two are
// contact-scoped (`champion_deal_count` + `multi_account_contact`).
// `'snapshot'` in the spec narrative maps to `temporal_class:
// 'time_bound'` at the substrate level (boolean state at observation
// time = moving-entity state at as_of); D-136 carries no `'snapshot'`
// temporal_class, so the closest substrate-honest mapping is
// time_bound.

/** D-139 P4 — `meeting_to_followup_lag` bucket enum. The deal-stage
 *  reading: a fast follow-up is healthy; slipping past `'long'` is
 *  a slipping-deal signal recipes alert on. */
export const MEETING_FOLLOWUP_LAG_BUCKETS = [
  'fast',     // ≤ 24h
  'normal',   // ≤ 72h
  'long',     // ≤ 7d
  'slipping', // > 7d
  'none',     // no follow-up landed yet
] as const;
export type MeetingFollowupLagBucket =
  (typeof MEETING_FOLLOWUP_LAG_BUCKETS)[number];
const MEETING_FOLLOWUP_LAG_BUCKET_SET: ReadonlySet<string> = new Set(
  MEETING_FOLLOWUP_LAG_BUCKETS,
);
const isMeetingFollowupLagBucket = (v: unknown): boolean =>
  typeof v === 'string' && MEETING_FOLLOWUP_LAG_BUCKET_SET.has(v);

/** D-139 P4 — `meeting_to_followup_lag` value shape. Reads the deal's
 *  most-recent completed meeting (CRM meeting/event with
 *  lifecycle_state = `'completed'` AND event_at populated) and the
 *  next outbound rep touch on the deal (mail outbound or CRM email
 *  outbound). Lag is the duration from meeting end → next outbound;
 *  bucket reads slipping-deal severity.
 *
 *  Filters per Pass-4 evidence-quality defaults:
 *    - meeting source: `lifecycle_state = 'completed'` only (scheduled
 *      / cancelled / rescheduled meetings don't count); direction
 *      `'internal'` excluded (rep-internal sync isn't a deal meeting).
 *    - outbound source: `direction = 'outbound'` AND `authorship IN
 *      ('user', 'crm_user')` AND `lifecycle_state IN ('point_in_time',
 *      'completed')`; failed sends + no_answer calls are NOT
 *      follow-up evidence (the touch didn't happen).
 *    - dedupe_acceptance: `'exact_only'` — probable-twin pairs treated
 *      as separate evidence to over-count rather than mis-merge. */
export interface MeetingToFollowupLagValue {
  /** Bucket — categorical for recipe gating. */
  bucket: MeetingFollowupLagBucket;
  /** Unix-ms event_at of the latest completed meeting on the deal.
   *  `0` when no qualifying meeting found. */
  last_meeting_at: number;
  /** Unix-ms event_at of the next outbound rep touch after the
   *  meeting. `0` when no follow-up landed yet (bucket = `'none'`
   *  OR `'slipping'`). */
  next_outbound_at: number;
  /** Lag in milliseconds from meeting → next outbound. `-1` when no
   *  follow-up exists yet (consumers compare against threshold; the
   *  producer never skips the row). */
  lag_ms: number;
  /** Producer cursor — max source `vendor_modified_at` folded across
   *  meeting + outbound rows. */
  cursor_at: number;
}

const MeetingToFollowupLagSchema: EnrichmentValueValidator<
  MeetingToFollowupLagValue
> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isMeetingFollowupLagBucket(obj.bucket)) {
    issues.push(
      `field 'bucket' must be one of ${MEETING_FOLLOWUP_LAG_BUCKETS.join(' / ')}`,
    );
  }
  if (!isNumber(obj.last_meeting_at) || (obj.last_meeting_at as number) < 0) {
    issues.push("field 'last_meeting_at' must be a non-negative finite number");
  }
  if (!isNumber(obj.next_outbound_at) || (obj.next_outbound_at as number) < 0) {
    issues.push("field 'next_outbound_at' must be a non-negative finite number");
  }
  if (!isNumber(obj.lag_ms)) {
    issues.push("field 'lag_ms' must be a finite number (-1 when no follow-up)");
  }
  if (!isNumber(obj.cursor_at)) {
    issues.push("field 'cursor_at' must be a finite number");
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as MeetingToFollowupLagValue };
};

/** D-139 P4 — `out_of_band_engagement` value shape. Surfaces the
 *  visibility gap where the rep emails a deal contact but the mail
 *  doesn't land in CRM — "your real work isn't visible to the
 *  system" signal.
 *
 *  Matching strategy per § A.9.2b:
 *    - Mail-to-CRM-engagement matching prefers `Message-ID` header.
 *      Fallback: `(from + to + sent_at + subject_hash)` quadruple.
 *    - Grace window: `OUT_OF_BAND_GRACE_MINUTES = 30` after CRM
 *      engagement landing (don't alert on mail < 30 min old; CRM
 *      logging is async).
 *    - Confidence gate: alerts ONLY when the contact has a clear
 *      primary-deal signal (single-deal contact OR primary-deal
 *      activity in last 14 days). Below threshold → mails don't
 *      count toward `out_of_band_count`.
 *
 *  Filters per Pass-4 evidence-quality defaults:
 *    - mail source: `authorship` user-typed; `direction = 'outbound'`
 *      (we surface rep mail that didn't land in CRM, not inbound).
 *    - dedupe_acceptance: `'exact_only'` — Message-ID match is
 *      `'exact'`; quadruple-fallback match is `'probable'` and is
 *      counted as out-of-band (probable-match isn't strong enough
 *      to assume "the CRM has it"). */
export interface OutOfBandEngagementValue {
  /** Count of outbound mails to deal contacts in the recent window
   *  (90d) that did NOT match a CRM engagement under the grace +
   *  confidence gates. */
  out_of_band_count: number;
  /** Unix-ms `event_at` of the most-recent unmatched mail. `0` when
   *  none found yet. */
  latest_unmatched_at: number;
  /** Whether the contact's deal-association confidence exceeded the
   *  threshold for the most-recent unmatched mail (single-deal
   *  contact OR primary-deal activity in last 14d). When false, the
   *  count is reported but recipes should NOT alert (false-positive
   *  mitigation). */
  confidence_gate_passed: boolean;
  /** Producer cursor — max source `vendor_modified_at` (mail or CRM)
   *  folded so far. */
  cursor_at: number;
}

const OutOfBandEngagementSchema: EnrichmentValueValidator<
  OutOfBandEngagementValue
> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.out_of_band_count) || (obj.out_of_band_count as number) < 0) {
    issues.push("field 'out_of_band_count' must be a non-negative finite number");
  }
  if (!isNumber(obj.latest_unmatched_at) || (obj.latest_unmatched_at as number) < 0) {
    issues.push("field 'latest_unmatched_at' must be a non-negative finite number");
  }
  if (typeof obj.confidence_gate_passed !== 'boolean') {
    issues.push("field 'confidence_gate_passed' must be boolean");
  }
  if (!isNumber(obj.cursor_at)) {
    issues.push("field 'cursor_at' must be a finite number");
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as OutOfBandEngagementValue };
};

/** D-139 P4 — `account_engagement_breadth` bucket enum. MEDDIC-flavored
 *  multi-threading read; recipes alert when an account has narrow
 *  engagement (single-thread, single point-of-contact risk). */
export const ACCOUNT_BREADTH_BUCKETS = [
  'narrow',         // 1 contact engaging
  'developing',     // 2-3 distinct contacts
  'multi_threaded', // 4+ distinct contacts
  'silent',         // 0 engaging contacts in window
] as const;
export type AccountBreadthBucket =
  (typeof ACCOUNT_BREADTH_BUCKETS)[number];
const ACCOUNT_BREADTH_BUCKET_SET: ReadonlySet<string> = new Set(
  ACCOUNT_BREADTH_BUCKETS,
);
const isAccountBreadthBucket = (v: unknown): boolean =>
  typeof v === 'string' && ACCOUNT_BREADTH_BUCKET_SET.has(v);

/** D-139 P4 — `account_engagement_breadth` value shape. Distinct
 *  contacts at the account that have engaged within the recent
 *  window (90d), recency-weighted. Surfaces multi-threading depth
 *  without scrolling org charts.
 *
 *  Recency weighting: each contact contributes a weight that decays
 *  over a 30d half-life from their most-recent engagement on the
 *  account. Sum is the `recency_weighted_score`; `distinct_contacts`
 *  is the unweighted count of contacts with at least one qualifying
 *  engagement in the window.
 *
 *  Filters per Pass-4 evidence-quality defaults:
 *    - direction `'internal'` excluded (rep-internal chatter doesn't
 *      indicate prospect engagement).
 *    - lifecycle filter: `'point_in_time' | 'completed'` only.
 *    - authorship `'crm_automation'` + `'system_process'` excluded
 *      (workflow auto-logs + tracking pixels don't indicate
 *      prospect-side engagement breadth). */
export interface AccountEngagementBreadthValue {
  /** Distinct contact count engaging at the account in the 90d
   *  window. Excludes internal-direction touches + auto/system-
   *  process authorship. */
  distinct_contacts: number;
  /** Sum of per-contact recency weights (30d half-life from each
   *  contact's most-recent qualifying engagement). */
  recency_weighted_score: number;
  /** Categorical bucket for recipe gating. */
  bucket: AccountBreadthBucket;
  /** Producer cursor — max source `vendor_modified_at` folded. */
  cursor_at: number;
}

const AccountEngagementBreadthSchema: EnrichmentValueValidator<
  AccountEngagementBreadthValue
> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.distinct_contacts) || (obj.distinct_contacts as number) < 0) {
    issues.push("field 'distinct_contacts' must be a non-negative finite number");
  }
  if (!isNumber(obj.recency_weighted_score) || (obj.recency_weighted_score as number) < 0) {
    issues.push(
      "field 'recency_weighted_score' must be a non-negative finite number",
    );
  }
  if (!isAccountBreadthBucket(obj.bucket)) {
    issues.push(
      `field 'bucket' must be one of ${ACCOUNT_BREADTH_BUCKETS.join(' / ')}`,
    );
  }
  if (!isNumber(obj.cursor_at)) {
    issues.push("field 'cursor_at' must be a finite number");
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as AccountEngagementBreadthValue };
};

/** D-139 P4 — `account_reentry_signal` value shape. Boolean
 *  state-at-observation: dormant account suddenly active. The signal
 *  flips `true` when the account had ≥ `ACCOUNT_DORMANCY_DAYS` (60)
 *  of zero qualifying engagement, then a qualifying engagement
 *  landed in the recent (last 14d) window. PSI-style drift detection
 *  is an optional D-133 follow-up.
 *
 *  Filters per Pass-4 evidence-quality defaults:
 *    - direction `'internal'` excluded.
 *    - lifecycle filter: `'point_in_time' | 'completed'` only.
 *    - authorship `'crm_automation'` + `'system_process'` excluded
 *      (workflow opens don't constitute reentry). */
export interface AccountReentrySignalValue {
  /** Whether the account is currently re-entering (dormant ≥ 60d
   *  followed by qualifying engagement in last 14d). */
  reentered: boolean;
  /** Days the account was dormant before reentry. `0` when
   *  `reentered = false`. */
  dormancy_days: number;
  /** Unix-ms event_at of the qualifying engagement that triggered
   *  reentry. `0` when `reentered = false`. */
  last_reentry_at: number;
  /** Producer cursor — max source `vendor_modified_at` folded. */
  cursor_at: number;
}

const AccountReentrySignalSchema: EnrichmentValueValidator<
  AccountReentrySignalValue
> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof obj.reentered !== 'boolean') {
    issues.push("field 'reentered' must be boolean");
  }
  if (!isNumber(obj.dormancy_days) || (obj.dormancy_days as number) < 0) {
    issues.push("field 'dormancy_days' must be a non-negative finite number");
  }
  if (!isNumber(obj.last_reentry_at) || (obj.last_reentry_at as number) < 0) {
    issues.push("field 'last_reentry_at' must be a non-negative finite number");
  }
  if (!isNumber(obj.cursor_at)) {
    issues.push("field 'cursor_at' must be a finite number");
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as AccountReentrySignalValue };
};

/** D-139 P4 — `champion_deal_count` bucket enum. Champions vs
 *  blockers across the book — recipes alert when a contact's deals
 *  bias toward losses (potential blocker) or carries multiple wins
 *  (champion to be cultivated for references / advocacy). */
export const CHAMPION_DEAL_BUCKETS = [
  'champion',  // ≥ 2 won deals AND win_rate ≥ 0.6
  'mixed',     // ≥ 1 won AND ≥ 1 lost
  'blocker',   // ≥ 2 lost deals AND win_rate ≤ 0.2
  'unknown',   // insufficient closed-deal sample
] as const;
export type ChampionDealBucket =
  (typeof CHAMPION_DEAL_BUCKETS)[number];
const CHAMPION_DEAL_BUCKET_SET: ReadonlySet<string> = new Set(
  CHAMPION_DEAL_BUCKETS,
);
const isChampionDealBucket = (v: unknown): boolean =>
  typeof v === 'string' && CHAMPION_DEAL_BUCKET_SET.has(v);

/** D-139 P4 — `champion_deal_count` value shape. Per-contact count
 *  of deals the contact has touched, segmented by closed status.
 *  Folds across HubSpot deal `close_state` ∈ `'won' | 'lost' | 'open'`
 *  + Salesforce opportunity `IsWon` / `IsClosed`.
 *
 *  Read across deals for one contact (`identity_aggregation:
 *  'perspective'` per D-136). The producer reads engagement_edges
 *  where `edge_type='contact'` AND `target_id` resolves to the
 *  contact's identity (post-D-138 expansion); each engagement walks
 *  back to its associated deal(s) via the deal-edge fan; closed
 *  status from the deal's CRM meta. */
export interface ChampionDealCountValue {
  /** Resolved subject-contact name (denormalized from the contacts
   *  directory at producer-run time). Harvest phase 1b. Optional. */
  name?: string;
  /** Subject-contact REF<contacts> identifier (today: canonical email).
   *  Optional during the producer-shape harvest. */
  entity?: string;
  /** Total distinct deals the contact has touched (any
   *  qualifying engagement). */
  total_deals: number;
  /** Closed-won deals. */
  won_deals: number;
  /** Closed-lost deals. */
  lost_deals: number;
  /** Currently-open deals. */
  open_deals: number;
  /** `won_deals / (won_deals + lost_deals)` over the closed sample.
   *  `0` when no closed deals (consumers compare against threshold;
   *  the producer never skips the row). */
  win_rate: number;
  /** Categorical bucket for recipe gating. */
  bucket: ChampionDealBucket;
  /** Producer cursor — max deal `vendor_modified_at` folded. */
  cursor_at: number;
}

const ChampionDealCountSchema: EnrichmentValueValidator<
  ChampionDealCountValue
> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.total_deals) || (obj.total_deals as number) < 0) {
    issues.push("field 'total_deals' must be a non-negative finite number");
  }
  if (!isNumber(obj.won_deals) || (obj.won_deals as number) < 0) {
    issues.push("field 'won_deals' must be a non-negative finite number");
  }
  if (!isNumber(obj.lost_deals) || (obj.lost_deals as number) < 0) {
    issues.push("field 'lost_deals' must be a non-negative finite number");
  }
  if (!isNumber(obj.open_deals) || (obj.open_deals as number) < 0) {
    issues.push("field 'open_deals' must be a non-negative finite number");
  }
  if (!isNumber(obj.win_rate) || (obj.win_rate as number) < 0 || (obj.win_rate as number) > 1) {
    issues.push("field 'win_rate' must be a finite number in [0, 1]");
  }
  if (!isChampionDealBucket(obj.bucket)) {
    issues.push(
      `field 'bucket' must be one of ${CHAMPION_DEAL_BUCKETS.join(' / ')}`,
    );
  }
  if (!isNumber(obj.cursor_at)) {
    issues.push("field 'cursor_at' must be a finite number");
  }
  if (!isOptionalString(obj.name)) issues.push("field 'name' must be string when present");
  if (!isOptionalString(obj.entity)) issues.push("field 'entity' must be string when present");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as ChampionDealCountValue };
};

/** D-139 P4 — `multi_account_contact` value shape. Boolean state-at-
 *  observation: contact's mail domain ≠ CRM company affiliation
 *  domain — likely job change, reactivation lead.
 *
 *  Comparison rule: canonical mail domain (lowercased, trimmed,
 *  no MX hints) compared against the contact's CRM company
 *  affiliation domains (HubSpot company.domain or Salesforce
 *  Account.Website parsed for host). Generic free-mail domains
 *  (`gmail.com` / `outlook.com` / `yahoo.com` / etc.) NEVER count
 *  as "different account" — they're not professional affiliations.
 *  Empty CRM-domain set → `is_multi_account = false` (insufficient
 *  signal; can't tell). */
export interface MultiAccountContactValue {
  /** Resolved subject-contact name (denormalized from the contacts
   *  directory at producer-run time). Harvest phase 1b. Optional. */
  name?: string;
  /** Subject-contact REF<contacts> identifier (today: canonical email).
   *  Optional during the producer-shape harvest. */
  entity?: string;
  /** Whether the contact's professional mail domain differs from
   *  every CRM-affiliation domain on file. */
  is_multi_account: boolean;
  /** The contact's canonical mail domain. `null` when no
   *  professional mail domain found (only free-mail or no mail). */
  mail_domain: string | null;
  /** CRM-affiliated company domains (lowercased + trimmed). May be
   *  empty when no affiliated company has a domain set. */
  crm_company_domains: string[];
  /** Producer cursor — max source `vendor_modified_at` folded. */
  cursor_at: number;
}

const MultiAccountContactSchema: EnrichmentValueValidator<
  MultiAccountContactValue
> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof obj.is_multi_account !== 'boolean') {
    issues.push("field 'is_multi_account' must be boolean");
  }
  if (obj.mail_domain !== null && typeof obj.mail_domain !== 'string') {
    issues.push("field 'mail_domain' must be a string or null");
  }
  if (!isStringArray(obj.crm_company_domains)) {
    issues.push("field 'crm_company_domains' must be string[]");
  }
  if (!isNumber(obj.cursor_at)) {
    issues.push("field 'cursor_at' must be a finite number");
  }
  if (!isOptionalString(obj.name)) issues.push("field 'name' must be string when present");
  if (!isOptionalString(obj.entity)) issues.push("field 'entity' must be string when present");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as MultiAccountContactValue };
};

// ────────────────────────────────────────────────────────────────
// D-139 P5 — AI-surface canary topic values
// ────────────────────────────────────────────────────────────────
//
// `engagement_sentiment_trend` + `next_best_action` per spec § A.9.2.
// Both are deal-scoped, manual-trust default per D-132, free-pool by
// default. Producers fold engagement evidence into AI-derived scalar
// outputs (sentiment buckets / recommended action). Output value-shape
// constraints (Pass-3 R3.6 + Pass-4 evidence-quality contracts):
//   - NO raw body text in the persisted value. Producers compute
//     scalar derivatives (tone score, key-phrase tokens, action
//     recommendation) from body content but never re-emit body text
//     into the row.
//   - Coverage metadata populates per § A.9.3.
//   - Value carries `cursor_at` (max source `vendor_modified_at`
//     folded) + `samples` count so consumers can reason about
//     freshness + sample density.

/** D-139 P5 — `engagement_sentiment_trend` tone-bucket enum. */
export const ENGAGEMENT_SENTIMENT_TONES = [
  'warming',
  'steady',
  'cooling',
  'volatile',
  'insufficient_signal',
] as const;
export type EngagementSentimentTone =
  (typeof ENGAGEMENT_SENTIMENT_TONES)[number];
const ENGAGEMENT_SENTIMENT_TONE_SET: ReadonlySet<string> = new Set(
  ENGAGEMENT_SENTIMENT_TONES,
);
const isEngagementSentimentTone = (v: unknown): boolean =>
  typeof v === 'string' && ENGAGEMENT_SENTIMENT_TONE_SET.has(v);

/** Cap on `key_phrases` length — caller-side guard so the LLM can't
 *  smuggle long body excerpts into the value via a giant token list. */
export const ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASES = 5;

/** Cap on individual key-phrase length in chars. Mirrors the
 *  `signals` cap on `lifecycle_stage_inferred`'s 100-char per-token
 *  limit; ensures the LLM can't produce a single phrase that contains
 *  a sentence of body content. */
export const ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASE_CHARS = 64;

/** D-139 P5 — `engagement_sentiment_trend` value shape. Tone
 *  trajectory across the deal's recent engagement window.
 *
 *  Closed-list bucket on `tone` plus `score` ∈ [-1, 1] (`-1` = strongly
 *  cooling; `+1` = strongly warming; `0` = neutral / steady). Producer
 *  emits `'insufficient_signal'` + `score: 0` + empty `key_phrases`
 *  when sample count falls below the floor. `key_phrases` carries up
 *  to 5 short tokens (≤ 64 chars each) — never raw body sentences;
 *  producer enforces with shape validators. */
export interface EngagementSentimentTrendValue {
  /** Closed bucket — substrate-friendly recipe gate. */
  tone: EngagementSentimentTone;
  /** Continuous tone score in [-1, 1]. `-1`/`+1` = strongly
   *  cooling/warming; `0` = neutral. */
  score: number;
  /** Up to 5 snake_case tokens (≤ 64 chars each) describing what
   *  drove the read (e.g. `'late_replies'`, `'positive_phrasing'`,
   *  `'meeting_cancellations'`). Validator enforces snake_case shape
   *  via `PROMPT_BIAS_HINT_RE` — body sentences (which contain
   *  spaces / capitals / punctuation) cannot leak through this slot
   *  even when an LLM tries to smuggle them. */
  key_phrases: ReadonlyArray<string>;
  /** Number of qualifying engagement rows folded — sample density
   *  signal. Below `MIN_SAMPLE` floor → `tone: 'insufficient_signal'`. */
  samples: number;
  /** Producer cursor — max source `vendor_modified_at` folded. Honest
   *  zero when no qualifying engagement seen yet. */
  cursor_at: number;
}

const EngagementSentimentTrendSchema: EnrichmentValueValidator<
  EngagementSentimentTrendValue
> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isEngagementSentimentTone(obj.tone)) {
    issues.push(
      `field 'tone' must be one of ${ENGAGEMENT_SENTIMENT_TONES.join(' / ')}`,
    );
  }
  if (
    !isNumber(obj.score) ||
    (obj.score as number) < -1 ||
    (obj.score as number) > 1
  ) {
    issues.push("field 'score' must be a finite number in [-1, 1]");
  }
  if (!isStringArray(obj.key_phrases)) {
    issues.push("field 'key_phrases' must be string[]");
  } else {
    const arr = obj.key_phrases as ReadonlyArray<string>;
    if (arr.length > ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASES) {
      issues.push(
        `field 'key_phrases' length must be ≤ ${ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASES}`,
      );
    }
    for (const phrase of arr) {
      if (phrase.length > ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASE_CHARS) {
        issues.push(
          `field 'key_phrases' entries must be ≤ ${ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASE_CHARS} chars (rejects body-shaped tokens)`,
        );
        break;
      }
      // Snake_case enforcement — body sentences contain spaces /
      // capitals / punctuation; the regex rejects them even when the
      // length is under the cap. Reuses PROMPT_BIAS_HINT_RE since
      // both fields enforce the same shape.
      if (!PROMPT_BIAS_HINT_RE.test(phrase)) {
        issues.push(
          `field 'key_phrases' entries must be snake_case lowercase tokens (matched by PROMPT_BIAS_HINT_RE) — rejects body-shaped strings`,
        );
        break;
      }
    }
  }
  if (!isNumber(obj.samples) || (obj.samples as number) < 0) {
    issues.push("field 'samples' must be a non-negative finite number");
  }
  if (!isNumber(obj.cursor_at) || (obj.cursor_at as number) < 0) {
    issues.push("field 'cursor_at' must be a non-negative finite number");
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as EngagementSentimentTrendValue };
};

/** D-139 P5 — `next_best_action` recommendation enum. Closed list so
 *  recipes can dispatch deterministically; LLM picks one of the
 *  enumerated values (or `'no_action'` when no clear next step). */
export const NEXT_BEST_ACTIONS = [
  'send_email',
  'schedule_meeting',
  'wait',
  'investigate',
  'escalate',
  'review_contact',
  'no_action',
] as const;
export type NextBestAction = (typeof NEXT_BEST_ACTIONS)[number];
const NEXT_BEST_ACTION_SET: ReadonlySet<string> = new Set(NEXT_BEST_ACTIONS);
const isNextBestAction = (v: unknown): boolean =>
  typeof v === 'string' && NEXT_BEST_ACTION_SET.has(v);

/** Cap on `rationale` length — short one-sentence explanation, not a
 *  body excerpt. Producer-side validator caps at this length to
 *  prevent body content from leaking via the rationale field. */
export const NEXT_BEST_ACTION_MAX_RATIONALE_CHARS = 200;

/** D-139 P5 — `next_best_action` value shape. Recommendation derived
 *  from engagement context. Closed `action` bucket + `confidence` ∈
 *  [0, 1] + short rationale (≤ 200 chars). Producer emits
 *  `action: 'no_action'` + `confidence: 0` when sample density falls
 *  below the floor; `valid_until_at` reflects the producer's
 *  freshness budget. */
export interface NextBestActionValue {
  /** Closed action bucket — recipes dispatch on this enum. */
  action: NextBestAction;
  /** Confidence in [0, 1]. `0` when `action: 'no_action'`. */
  confidence: number;
  /** Free-form one-sentence explanation (≤ 200 chars). Validator caps
   *  the length so body content can't leak via the rationale slot. */
  rationale: string;
  /** Number of qualifying engagement rows folded into the
   *  recommendation. Below `MIN_SAMPLE` floor → `action: 'no_action'`. */
  samples: number;
  /** Producer-declared freshness horizon (unix-ms). Recipes treat the
   *  recommendation as stale past this timestamp; the topic's
   *  `lifecycle_policy: 'historical'` preserves the row but consumer
   *  recipes gate on freshness explicitly. */
  valid_until_at: number;
  /** `ctx.now()` when the recommendation was produced. */
  computed_at: number;
  /** Producer cursor — max source `vendor_modified_at` folded. */
  cursor_at: number;
}

const NextBestActionSchema: EnrichmentValueValidator<NextBestActionValue> = (
  value,
) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNextBestAction(obj.action)) {
    issues.push(`field 'action' must be one of ${NEXT_BEST_ACTIONS.join(' / ')}`);
  }
  if (
    !isNumber(obj.confidence) ||
    (obj.confidence as number) < 0 ||
    (obj.confidence as number) > 1
  ) {
    issues.push("field 'confidence' must be a finite number in [0, 1]");
  }
  if (!isString(obj.rationale)) {
    issues.push("field 'rationale' must be a string");
  } else if (
    (obj.rationale as string).length > NEXT_BEST_ACTION_MAX_RATIONALE_CHARS
  ) {
    issues.push(
      `field 'rationale' must be ≤ ${NEXT_BEST_ACTION_MAX_RATIONALE_CHARS} chars (rejects body-shaped strings)`,
    );
  }
  if (!isNumber(obj.samples) || (obj.samples as number) < 0) {
    issues.push("field 'samples' must be a non-negative finite number");
  }
  if (!isNumber(obj.valid_until_at) || (obj.valid_until_at as number) < 0) {
    issues.push("field 'valid_until_at' must be a non-negative finite number");
  }
  if (!isNumber(obj.computed_at) || (obj.computed_at as number) < 0) {
    issues.push("field 'computed_at' must be a non-negative finite number");
  }
  if (!isNumber(obj.cursor_at) || (obj.cursor_at as number) < 0) {
    issues.push("field 'cursor_at' must be a non-negative finite number");
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as NextBestActionValue };
};

// ────────────────────────────────────────────────────────────────
// D-139 P6.B — `commitment_tracker` post-substrate canary value
// ────────────────────────────────────────────────────────────────
//
// Privacy-tier separated from the deterministic P6.A pack. Extracts
// commitments ("you said you'd send X by Friday") from mail bodies +
// calendar descriptions + memory entries + per-type engagement
// bodies. AI-surface; manual trust default per D-132; free-pool
// default per spec § P6.B. Per-contact perspective storage — one row
// per canonical contact email carrying that contact's commitments[]
// across deals (deal context lives in `evidence_links`).
//
// Output value-shape body-text safety constraints (Pass-3 R3.6 +
// Pass-4 evidence-quality contracts + Pass-5 R5.9):
//   - `text` capped at COMMITMENT_TEXT_MAX_CHARS (200 chars) — short
//     paraphrase, NOT a body excerpt. Validator rejects long values.
//   - `evidence_links[].source` is a closed enum (no free-form source
//     strings can smuggle body text through this slot).
//   - `evidence_links[]` capped at COMMITMENT_EVIDENCE_LINKS_MAX (8
//     entries per commitment) so the row's payload size is bounded.
//   - `commitments[]` capped at COMMITMENT_TRACKER_COMMITMENTS_MAX
//     (50 commitments per contact) so the row stays MCP-projectable
//     without paginated fetches. Per-contact carries the active set;
//     historical lifecycle preserves the trajectory across cycles.
//   - `actor_email` strict shape — substring contains '@' and is at
//     least 3 chars. Rejects "subject:" injection / body sentences.
//
// Cross-source provenance (per spec § P6.B substrate dependencies):
// every commitment carries D-120 link-graph `evidence_links` listing
// the source records (mail / calendar / memory entry ids + per-type
// engagement target_ids + attachment vendor URLs when applicable)
// that informed the LLM's extraction. UI renders "Extracted from:
// [Mail Re: Q4 plans, 2026-04-22] [Calendar Acme Sync, 2026-04-25]
// [Attachment: agenda.pdf]" with click-through affordances.

/** D-139 P6.B — closed-list status enum for a tracked commitment.
 *  `'pending'` is the default state at extraction; `'fulfilled'` /
 *  `'broken'` / `'expired'` / `'cancelled'` come from cycle-time
 *  re-evaluation against fresh evidence (a follow-up email landing
 *  before due_at flips pending → fulfilled; the due_at passing without
 *  a follow-up flips pending → expired). */
export const COMMITMENT_STATUSES = [
  'pending',
  'fulfilled',
  'broken',
  'expired',
  'cancelled',
] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];
const COMMITMENT_STATUS_SET: ReadonlySet<string> = new Set(COMMITMENT_STATUSES);
const isCommitmentStatus = (v: unknown): boolean =>
  typeof v === 'string' && COMMITMENT_STATUS_SET.has(v);

/** D-139 P6.B — closed-list source taxonomy for `evidence_links`.
 *  Mirrors the topic's `aggregates_from` enumeration: warehouse
 *  collections (`mail` / `calendar` / `memory`) + per-type CRM
 *  engagement scopes + standalone `attachment` for attachment-by-
 *  vendor-URL evidence. Closed list — no free-form source strings can
 *  pass through this slot.
 *
 *  ⛔ `'memory'` HERE IS DELIBERATELY NOT RENAMED, and the mismatch with
 *  `aggregates_from`'s `'audit'` (2026-08-11) is intentional. This list is a
 *  PERSISTED value taxonomy — `evidence_links[].source` is written into the
 *  stored enrichment row and validated against this enum on read, so renaming
 *  the member would invalidate every row already carrying it. That is a data
 *  migration, not a rename. It means the same thing the old `aggregates_from`
 *  member did (the run-provenance trail, never `user_memory`); do not
 *  "reconcile" the two by editing this list. */
export const COMMITMENT_EVIDENCE_SOURCES = [
  'mail',
  'calendar',
  'memory',
  'engagement_email',
  'engagement_meeting',
  'engagement_note',
  'engagement_call',
  'engagement_task',
  'engagement_event',
  'engagement_email_message',
  'engagement_voice_call',
  'engagement_call_history',
  'attachment',
] as const;
export type CommitmentEvidenceSource =
  (typeof COMMITMENT_EVIDENCE_SOURCES)[number];
const COMMITMENT_EVIDENCE_SOURCE_SET: ReadonlySet<string> = new Set(
  COMMITMENT_EVIDENCE_SOURCES,
);
const isCommitmentEvidenceSource = (v: unknown): boolean =>
  typeof v === 'string' && COMMITMENT_EVIDENCE_SOURCE_SET.has(v);

/** D-139 P6.B — cap on `commitment.text` length. Producer-side
 *  validator caps at this length to prevent mail-body sentences from
 *  leaking through the paraphrase slot. */
export const COMMITMENT_TEXT_MAX_CHARS = 200;

/** D-139 P6.B — cap on filename length on attachment evidence links.
 *  Same shape-rejection rationale as `text` — short filename, never a
 *  body sentence. */
export const COMMITMENT_EVIDENCE_FILENAME_MAX_CHARS = 200;

/** D-139 P6.B — cap on `vendor_url` length on attachment evidence
 *  links. Long enough for HubSpot / Salesforce attachment URLs;
 *  short enough that a body-shaped string can't smuggle through. */
export const COMMITMENT_EVIDENCE_VENDOR_URL_MAX_CHARS = 1000;

/** D-139 P6.B — cap on `source_id` length. Vendor IDs run ~50 chars
 *  (HubSpot 19-digit numerics; Salesforce 18-char alphanumerics; mail
 *  Message-IDs ~80 chars). 200-char cap rejects body-shaped strings
 *  smuggled through this slot. */
export const COMMITMENT_EVIDENCE_SOURCE_ID_MAX_CHARS = 200;

/** D-139 P6.B — cap on `evidence_links` per commitment. Bounds row
 *  payload + ensures the UI's "Extracted from: [Mail …] [Calendar …]"
 *  rendering doesn't blow out for high-evidence commitments. */
export const COMMITMENT_EVIDENCE_LINKS_MAX = 8;

/** D-139 P6.B — cap on `commitments` per row. Bounds row size + keeps
 *  MCP projection cheap. Per-contact perspective; historical
 *  lifecycle preserves trajectory across cycles even when individual
 *  rows reach the cap. */
export const COMMITMENT_TRACKER_COMMITMENTS_MAX = 50;

/** D-139 P6.B — minimum `actor_email` length. Rejects empty / single-
 *  char / no-@ values. */
export const COMMITMENT_ACTOR_EMAIL_MIN_CHARS = 3;

/** D-139 P6.B — maximum `actor_email` length. RFC 5321 caps the
 *  full address (local + '@' + domain) at 254 chars; we enforce that
 *  bound to reject body-paragraph strings smuggled through the
 *  field. Codex /codex:review P2 #3 fold-back — `isValidActorEmail`
 *  previously accepted any string containing '@', so a producer or
 *  LLM emitting a stray body sentence with an embedded address
 *  could leak text via the `actor_email` slot the same way the
 *  `text` cap closes the body-content path. */
export const COMMITMENT_ACTOR_EMAIL_MAX_CHARS = 254;

/** D-139 P6.B — strict shape regex for `actor_email`. RFC 5321 +
 *  RFC 5322 in practice converge on the substrate's existing email
 *  shape: one local + '@' + one or more domain labels separated by
 *  '.', no whitespace, no commas, no control chars. Mirrors the
 *  regex pattern used by D-138's contact-identity resolver so the
 *  two paths agree on what counts as a canonical email; rejects
 *  body-shaped strings (sentence with newlines / paragraph with
 *  multiple addresses / "Send to: foo@example.com, bar@example.com"
 *  garbage) regardless of length cap. */
export const COMMITMENT_ACTOR_EMAIL_RE =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** D-139 P6.B — evidence link entry. Closed-list source taxonomy +
 *  bounded string lengths so body content can't smuggle through any
 *  slot. `vendor_url` populated only for `'attachment'` source.
 *  `filename` populated only for `'attachment'` source. */
export interface CommitmentEvidenceLink {
  source: CommitmentEvidenceSource;
  /** Source record identifier — mail message id, calendar event id,
   *  memory entry id, engagement target_id (per-type), or attachment
   *  vendor_attachment_id. Bounded by
   *  COMMITMENT_EVIDENCE_SOURCE_ID_MAX_CHARS. */
  source_id: string;
  /** Unix-ms timestamp when the source was authored. Producers fold
   *  the source's `vendor_modified_at` (engagements), `Date:` header
   *  (mail), `start.dateTime` (calendar), or `event_at` (memory). */
  source_at: number;
  /** Vendor-side download URL — populated only when source is
   *  `'attachment'`. Substrate does not mirror attachment blobs at
   *  v1 per Pass-4 R4.3; UI renders the URL as a click-through with
   *  the user's vendor auth. */
  vendor_url?: string;
  /** Attachment filename — populated only when source is
   *  `'attachment'`. Bounded length + closed-source-list combine to
   *  prevent body-content leakage through this slot. */
  filename?: string;
}

/** D-139 P6.B — single commitment row inside the
 *  `CommitmentTrackerValue.commitments[]` array. Local to the
 *  `commitment_tracker` AI-surface canary topic. The substrate-level
 *  canonical work entity that subsumes this concept lives in
 *  `work-entities.ts` as `Commitment` (D-145 PA1); this row is a
 *  per-contact AI-extracted snapshot rather than the substrate
 *  primary. */
export interface TrackedCommitment {
  /** Stable id — content-hash of the commitment's text +
   *  primary evidence source so re-extraction doesn't duplicate.
   *  Substrate-internal; not parsed by recipes (recipes filter on
   *  `status` / `due_at` instead). */
  commitment_id: string;
  /** Short LLM-paraphrased text (≤ COMMITMENT_TEXT_MAX_CHARS chars).
   *  Validator caps the length so mail-body sentences can't leak
   *  through this slot. */
  text: string;
  /** Closed-list status enum — recipes dispatch on this field. */
  status: CommitmentStatus;
  /** Canonical email of the person who made the commitment.
   *  Substrate-validated for shape sanity (≥ 3 chars + literal '@'). */
  actor_email: string;
  /** Resolved name of the commitment's actor (pre-resolved via the
   *  contacts directory at producer-run time). Harvest phase 1b.
   *  Optional during the producer-shape harvest. */
  actor_name?: string;
  /** Optional unix-ms due timestamp. Absent when no explicit due
   *  phrasing in the source ("I'll get back to you" without "by
   *  Friday" → no due_at). */
  due_at?: number;
  /** Sources backing this commitment. Capped at
   *  COMMITMENT_EVIDENCE_LINKS_MAX entries to bound payload size +
   *  keep the UI rendering tractable. */
  evidence_links: ReadonlyArray<CommitmentEvidenceLink>;
  /** Unix-ms when the LLM extracted the commitment. */
  extracted_at: number;
  /** LLM confidence in [0, 1]. Producers below
   *  COMMITMENT_TRACKER_MIN_CONFIDENCE filter the commitment out
   *  before persisting (no row written rather than persisted with
   *  low confidence). */
  confidence: number;
}

/** D-139 P6.B — per-contact commitment-tracker value shape. Stored
 *  per (contact_email) row; `commitments[]` is the active commitment
 *  set across all deals/accounts the contact participates in. */
export interface CommitmentTrackerValue {
  /** Resolved subject-contact name (denormalized from the contacts
   *  directory at producer-run time). Harvest phase 1b. Optional. */
  name?: string;
  /** Subject-contact REF<contacts> identifier (today: canonical email).
   *  Optional during the producer-shape harvest. */
  entity?: string;
  /** Active commitments for this contact. Capped at
   *  COMMITMENT_TRACKER_COMMITMENTS_MAX entries; producer's
   *  `lifecycle_state` flip drops fulfilled / cancelled / broken
   *  commitments from the active set on next cycle. */
  commitments: ReadonlyArray<TrackedCommitment>;
  /** Number of qualifying source rows folded into this row's
   *  computation. Below MIN_SAMPLE floor → producer emits an empty
   *  `commitments[]` (no row written rather than persisted-empty,
   *  per the producer's authorship + lifecycle filter). */
  samples: number;
  /** Producer cursor — max source `vendor_modified_at` /
   *  `last_modified_at` / `event_at` folded across all aggregates_from
   *  sources. Honest zero when no qualifying source seen yet. */
  cursor_at: number;
  /** `ctx.now()` when the producer ran. Drives historical lifecycle
   *  trajectory + freshness signaling. */
  computed_at: number;
}

const isValidActorEmail = (v: unknown): boolean =>
  typeof v === 'string' &&
  v.length >= COMMITMENT_ACTOR_EMAIL_MIN_CHARS &&
  v.length <= COMMITMENT_ACTOR_EMAIL_MAX_CHARS &&
  COMMITMENT_ACTOR_EMAIL_RE.test(v);

const validateCommitmentEvidenceLink = (
  v: unknown,
  pathPrefix: string,
): string[] => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return [`${pathPrefix} must be an object`];
  }
  const obj = v as Record<string, unknown>;
  const issues: string[] = [];
  if (!isCommitmentEvidenceSource(obj.source)) {
    issues.push(
      `${pathPrefix}.source must be one of ${COMMITMENT_EVIDENCE_SOURCES.join(' / ')}`,
    );
  }
  if (
    !isString(obj.source_id) ||
    (obj.source_id as string).length === 0 ||
    (obj.source_id as string).length > COMMITMENT_EVIDENCE_SOURCE_ID_MAX_CHARS
  ) {
    issues.push(
      `${pathPrefix}.source_id must be a non-empty string ≤ ${COMMITMENT_EVIDENCE_SOURCE_ID_MAX_CHARS} chars`,
    );
  }
  if (!isNumber(obj.source_at) || (obj.source_at as number) < 0) {
    issues.push(
      `${pathPrefix}.source_at must be a non-negative finite number`,
    );
  }
  if (obj.vendor_url !== undefined) {
    if (
      !isString(obj.vendor_url) ||
      (obj.vendor_url as string).length > COMMITMENT_EVIDENCE_VENDOR_URL_MAX_CHARS
    ) {
      issues.push(
        `${pathPrefix}.vendor_url must be a string ≤ ${COMMITMENT_EVIDENCE_VENDOR_URL_MAX_CHARS} chars when present`,
      );
    }
    // vendor_url should only appear on attachment-source links;
    // closed-list source enforcement above pairs with this check.
    if (obj.source !== 'attachment') {
      issues.push(
        `${pathPrefix}.vendor_url permitted only when source = 'attachment' (got source = ${JSON.stringify(obj.source)})`,
      );
    }
  }
  if (obj.filename !== undefined) {
    if (
      !isString(obj.filename) ||
      (obj.filename as string).length === 0 ||
      (obj.filename as string).length > COMMITMENT_EVIDENCE_FILENAME_MAX_CHARS
    ) {
      issues.push(
        `${pathPrefix}.filename must be a non-empty string ≤ ${COMMITMENT_EVIDENCE_FILENAME_MAX_CHARS} chars when present`,
      );
    }
    if (obj.source !== 'attachment') {
      issues.push(
        `${pathPrefix}.filename permitted only when source = 'attachment' (got source = ${JSON.stringify(obj.source)})`,
      );
    }
  }
  return issues;
};

const validateTrackedCommitment = (v: unknown, pathPrefix: string): string[] => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return [`${pathPrefix} must be an object`];
  }
  const obj = v as Record<string, unknown>;
  const issues: string[] = [];
  if (!isString(obj.commitment_id) || (obj.commitment_id as string).length === 0) {
    issues.push(`${pathPrefix}.commitment_id must be a non-empty string`);
  }
  if (!isString(obj.text)) {
    issues.push(`${pathPrefix}.text must be a string`);
  } else if ((obj.text as string).length > COMMITMENT_TEXT_MAX_CHARS) {
    issues.push(
      `${pathPrefix}.text must be ≤ ${COMMITMENT_TEXT_MAX_CHARS} chars (rejects body-shaped strings)`,
    );
  } else if ((obj.text as string).length === 0) {
    issues.push(`${pathPrefix}.text must be a non-empty string`);
  }
  if (!isCommitmentStatus(obj.status)) {
    issues.push(
      `${pathPrefix}.status must be one of ${COMMITMENT_STATUSES.join(' / ')}`,
    );
  }
  if (!isValidActorEmail(obj.actor_email)) {
    issues.push(
      `${pathPrefix}.actor_email must be a canonical email shape (≥ ${COMMITMENT_ACTOR_EMAIL_MIN_CHARS} chars, ≤ ${COMMITMENT_ACTOR_EMAIL_MAX_CHARS} chars, single '@' separating local from FQDN — rejects body-shaped strings)`,
    );
  }
  if (!isOptionalString(obj.actor_name)) {
    issues.push(`${pathPrefix}.actor_name must be string when present`);
  }
  if (obj.due_at !== undefined) {
    if (!isNumber(obj.due_at) || (obj.due_at as number) < 0) {
      issues.push(
        `${pathPrefix}.due_at must be a non-negative finite number when present`,
      );
    }
  }
  if (!Array.isArray(obj.evidence_links)) {
    issues.push(`${pathPrefix}.evidence_links must be an array`);
  } else if (obj.evidence_links.length > COMMITMENT_EVIDENCE_LINKS_MAX) {
    issues.push(
      `${pathPrefix}.evidence_links length must be ≤ ${COMMITMENT_EVIDENCE_LINKS_MAX}`,
    );
  } else if (obj.evidence_links.length === 0) {
    issues.push(
      `${pathPrefix}.evidence_links must contain at least one entry (every commitment carries evidence per § P6.B)`,
    );
  } else {
    obj.evidence_links.forEach((entry: unknown, idx: number) => {
      issues.push(
        ...validateCommitmentEvidenceLink(entry, `${pathPrefix}.evidence_links[${idx}]`),
      );
    });
  }
  if (!isNumber(obj.extracted_at) || (obj.extracted_at as number) < 0) {
    issues.push(
      `${pathPrefix}.extracted_at must be a non-negative finite number`,
    );
  }
  if (
    !isNumber(obj.confidence) ||
    (obj.confidence as number) < 0 ||
    (obj.confidence as number) > 1
  ) {
    issues.push(
      `${pathPrefix}.confidence must be a finite number in [0, 1]`,
    );
  }
  return issues;
};

const CommitmentTrackerSchema: EnrichmentValueValidator<CommitmentTrackerValue> = (
  value,
) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!Array.isArray(obj.commitments)) {
    issues.push("field 'commitments' must be an array");
  } else if (obj.commitments.length > COMMITMENT_TRACKER_COMMITMENTS_MAX) {
    issues.push(
      `field 'commitments' length must be ≤ ${COMMITMENT_TRACKER_COMMITMENTS_MAX}`,
    );
  } else {
    obj.commitments.forEach((entry: unknown, idx: number) => {
      issues.push(...validateTrackedCommitment(entry, `commitments[${idx}]`));
    });
  }
  if (!isNumber(obj.samples) || (obj.samples as number) < 0) {
    issues.push("field 'samples' must be a non-negative finite number");
  }
  if (!isNumber(obj.cursor_at) || (obj.cursor_at as number) < 0) {
    issues.push("field 'cursor_at' must be a non-negative finite number");
  }
  if (!isNumber(obj.computed_at) || (obj.computed_at as number) < 0) {
    issues.push("field 'computed_at' must be a non-negative finite number");
  }
  if (!isOptionalString(obj.name)) issues.push("field 'name' must be string when present");
  if (!isOptionalString(obj.entity)) issues.push("field 'entity' must be string when present");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as CommitmentTrackerValue };
};

/** D-129 P6 — `lifecycle_stage_inferred` value shape. AI-classified
 *  normalised stage for a HubSpot contact, derived from contact meta +
 *  Recued local mail/calendar activity + behavioral_signature. Surfaces
 *  the gap when the user's HubSpot lifecyclestage setting drifts away
 *  from observed behaviour ("HubSpot says lead, but they're acting like
 *  a customer"). */
export const LIFECYCLE_STAGES = [
  'subscriber',
  'lead',
  'mql',
  'sql',
  'opportunity',
  'customer',
  'evangelist',
] as const;

export type LifecycleStage = typeof LIFECYCLE_STAGES[number];

const LIFECYCLE_STAGE_SET: ReadonlySet<string> = new Set(LIFECYCLE_STAGES);

const isLifecycleStage = (v: unknown): boolean =>
  typeof v === 'string' && LIFECYCLE_STAGE_SET.has(v);

export interface LifecycleStageInferredValue {
  /** Resolved subject-contact name (denormalized from the contacts
   *  directory at producer-run time). Harvest phase 1b. Optional. */
  name?: string;
  /** Subject-contact REF<contacts> identifier (today: canonical email).
   *  Optional during the producer-shape harvest. */
  entity?: string;
  /** Normalised lifecycle stage inferred from observed behaviour. */
  stage: LifecycleStage;
  /** Free-form one-sentence explanation. Surfaces in the Memory tab +
   *  audit feed; not parsed by recipes. */
  reasoning: string;
  /** Up to 5 short tokens describing the load-bearing signals
   *  (e.g. `'mail_volume_30d:12'`, `'meetings_30d:3'`,
   *  `'role_category:executive'`). Recipes can read these to gate on
   *  specific signal presence without re-running the producer. */
  signals: string[];
  /** `ctx.now()` when the inference was produced. */
  computed_at: number;
}

const LifecycleStageInferredSchema: EnrichmentValueValidator<LifecycleStageInferredValue> =
  (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, issues: ['expected object'] };
    }
    const obj = value as Record<string, unknown>;
    const issues: string[] = [];
    if (!isLifecycleStage(obj.stage)) {
      issues.push(`field 'stage' must be one of ${LIFECYCLE_STAGES.join(' / ')}`);
    }
    if (!isString(obj.reasoning)) issues.push("field 'reasoning' must be a string");
    if (!isStringArray(obj.signals)) issues.push("field 'signals' must be string[]");
    if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
    if (!isOptionalString(obj.name)) issues.push("field 'name' must be string when present");
    if (!isOptionalString(obj.entity)) issues.push("field 'entity' must be string when present");
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: obj as unknown as LifecycleStageInferredValue };
  };

/** D-130 P6 — `lifecycle_stage_inferred_salesforce` value shape.
 *  AI-classified normalised stage for a Salesforce contact, derived
 *  from contact meta + Recued local mail/calendar activity +
 *  behavioral_signature. Parallel topic to the HubSpot-flavored
 *  `lifecycle_stage_inferred`; stage enum diverges per spec
 *  decision §11 — Salesforce's vocabulary (`Lead` / `Prospect` /
 *  `Customer` / `Prior Customer` / `Partner` / `Other`) doesn't map
 *  cleanly onto HubSpot's 7-stage model, so closing the enum is
 *  vendor-specific. */
export const SALESFORCE_LIFECYCLE_STAGES = [
  'lead',
  'prospect',
  'customer',
  'prior_customer',
  'partner',
  'other',
] as const;

export type SalesforceLifecycleStage = typeof SALESFORCE_LIFECYCLE_STAGES[number];

const SALESFORCE_LIFECYCLE_STAGE_SET: ReadonlySet<string> =
  new Set(SALESFORCE_LIFECYCLE_STAGES);

const isSalesforceLifecycleStage = (v: unknown): boolean =>
  typeof v === 'string' && SALESFORCE_LIFECYCLE_STAGE_SET.has(v);

export interface LifecycleStageInferredSalesforceValue {
  /** Resolved subject-contact name (denormalized from the contacts
   *  directory at producer-run time). Harvest phase 1b. Optional. */
  name?: string;
  /** Subject-contact REF<contacts> identifier (today: canonical email).
   *  Optional during the producer-shape harvest. */
  entity?: string;
  /** Normalised lifecycle stage inferred from observed behaviour. */
  stage: SalesforceLifecycleStage;
  /** Free-form one-sentence explanation. Surfaces in the Memory tab +
   *  audit feed; not parsed by recipes. */
  reasoning: string;
  /** Up to 5 short tokens describing the load-bearing signals
   *  (e.g. `'mail_volume_30d:12'`, `'meetings_30d:3'`,
   *  `'role_category:executive'`). Recipes can read these to gate on
   *  specific signal presence without re-running the producer. */
  signals: string[];
  /** `ctx.now()` when the inference was produced. */
  computed_at: number;
}

const LifecycleStageInferredSalesforceSchema: EnrichmentValueValidator<LifecycleStageInferredSalesforceValue> =
  (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, issues: ['expected object'] };
    }
    const obj = value as Record<string, unknown>;
    const issues: string[] = [];
    if (!isSalesforceLifecycleStage(obj.stage)) {
      issues.push(
        `field 'stage' must be one of ${SALESFORCE_LIFECYCLE_STAGES.join(' / ')}`,
      );
    }
    if (!isString(obj.reasoning)) issues.push("field 'reasoning' must be a string");
    if (!isStringArray(obj.signals)) issues.push("field 'signals' must be string[]");
    if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
    if (!isOptionalString(obj.name)) issues.push("field 'name' must be string when present");
    if (!isOptionalString(obj.entity)) issues.push("field 'entity' must be string when present");
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: obj as unknown as LifecycleStageInferredSalesforceValue };
  };

/** D-129 P6 — `attribution_signal` value shape. Deterministic
 *  first-touch attribution for a HubSpot deal — joins deal create
 *  timestamp + linked contacts + Recued local mail timeline to surface
 *  the source / channel / earliest meaningful touch. */
export const ATTRIBUTION_SOURCES = [
  'cold_outbound',
  'inbound_inquiry',
  'referral',
  'event',
  'unknown',
] as const;

export type AttributionSource = typeof ATTRIBUTION_SOURCES[number];

const ATTRIBUTION_SOURCE_SET: ReadonlySet<string> = new Set(ATTRIBUTION_SOURCES);

const isAttributionSource = (v: unknown): boolean =>
  typeof v === 'string' && ATTRIBUTION_SOURCE_SET.has(v);

export interface AttributionSignalValue {
  /** Closed-set attribution bucket. `'unknown'` when no signal was
   *  conclusive — no contacts linked, no mail timeline, no calendar
   *  history within the look-back window. */
  first_touch_source: AttributionSource;
  /** Unix-ms of the earliest meaningful touch the attribution rule
   *  identified. Falls back to deal `key_dates.created_at` when no
   *  cross-source match was found (paired with `first_touch_source:
   *  'unknown'`). */
  first_touch_at: number;
  /** Free-form short string describing the channel
   *  (e.g. `'email'`, `'meeting'`, `'cold_call'`, `'unknown'`). */
  first_touch_channel: string;
  /** Up to 5 short tokens describing the supporting evidence
   *  (e.g. `'mail_thread:abc123'`, `'contact_count:3'`,
   *  `'meeting_within_24h_of_create:true'`). */
  signals: string[];
  /** `ctx.now()` when the attribution was computed. */
  computed_at: number;
}

const AttributionSignalSchema: EnrichmentValueValidator<AttributionSignalValue> =
  (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, issues: ['expected object'] };
    }
    const obj = value as Record<string, unknown>;
    const issues: string[] = [];
    if (!isAttributionSource(obj.first_touch_source)) {
      issues.push(`field 'first_touch_source' must be one of ${ATTRIBUTION_SOURCES.join(' / ')}`);
    }
    if (!isNumber(obj.first_touch_at)) issues.push("field 'first_touch_at' must be a finite number");
    if (!isString(obj.first_touch_channel)) issues.push("field 'first_touch_channel' must be a string");
    if (!isStringArray(obj.signals)) issues.push("field 'signals' must be string[]");
    if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: obj as unknown as AttributionSignalValue };
  };

// ────────────────────────────────────────────────────────────────
// D-145 PA9 — value schemas (work-entity + engine + reliability)
// ────────────────────────────────────────────────────────────────
//
// 16 producers per spec § A.7.1 + § A.7.2. Many share a small set
// of value shapes — PSI-eligible producers all carry
// `{score, sample_count, confidence, computed_at}`; deterministic
// signal-and-state producers carry `{signal, computed_at}`-shaped
// values. Per-producer typed value interfaces document the contract;
// schemas are the registry-time validators. Schemas reject extra
// fields by absence of a check (objectShape pattern matches existing
// registry topics — extra fields are forward-compatible).

/** PSI-eligible producer value shape. Used by:
 *    - commitment_followthrough_score (PA9.a)
 *    - task_completion_velocity (PA9.a)
 *    - project_velocity (PA9.a)
 *    - context_packet_quality (PA9.b)
 *
 *  Schema validates `score` / `confidence` are finite numbers; the 0..1
 *  bounded-range invariant is producer-side. PSI-eligible producers
 *  must normalize their score into [0, 1] before persisting (velocity
 *  producers map raw counts via per-period / max-per-period; score-
 *  style producers emit the proportion directly). PB phase wires the
 *  normalization. */
export interface PsiEligibleScoreValue {
  /** 0..1 emitted score (producer-normalized; not schema-enforced). */
  score: number;
  /** Source-row count contributing to the score. PSI-calibration
   *  baseline requires ≥ 30 (`PSI_SAMPLE_FLOOR_MINIMUM`). */
  sample_count: number;
  /** 0..1 emitted confidence. PSI iterates this distribution per
   *  D-133. */
  confidence: number;
  computed_at: number;
}

const PsiEligibleScoreSchema: EnrichmentValueValidator<PsiEligibleScoreValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.score)) issues.push("field 'score' must be a finite number");
  if (!isNumber(obj.sample_count)) issues.push("field 'sample_count' must be a finite number");
  if (!isNumber(obj.confidence)) issues.push("field 'confidence' must be a finite number");
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as PsiEligibleScoreValue };
};

/** `commitment_imbalance` value shape — per-contact signal of
 *  inbound-vs-outbound commitment skew over the rolling window. */
export const COMMITMENT_IMBALANCE_SIGNALS = [
  'aligned',
  'inbound_heavy',
  'outbound_heavy',
  'insufficient_data',
] as const;
export type CommitmentImbalanceSignal = typeof COMMITMENT_IMBALANCE_SIGNALS[number];
const COMMITMENT_IMBALANCE_SIGNAL_SET: ReadonlySet<string> = new Set(COMMITMENT_IMBALANCE_SIGNALS);
const isCommitmentImbalanceSignal = (v: unknown): boolean =>
  typeof v === 'string' && COMMITMENT_IMBALANCE_SIGNAL_SET.has(v);

export interface CommitmentImbalanceValue {
  inbound_count: number;
  outbound_count: number;
  imbalance_signal: CommitmentImbalanceSignal;
  computed_at: number;
}

const CommitmentImbalanceSchema: EnrichmentValueValidator<CommitmentImbalanceValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.inbound_count)) issues.push("field 'inbound_count' must be a finite number");
  if (!isNumber(obj.outbound_count)) issues.push("field 'outbound_count' must be a finite number");
  if (!isCommitmentImbalanceSignal(obj.imbalance_signal)) {
    issues.push(`field 'imbalance_signal' must be one of ${COMMITMENT_IMBALANCE_SIGNALS.join(' / ')}`);
  }
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as CommitmentImbalanceValue };
};

/** `outbound_commitment_overdue_count` — per-contact count of overdue
 *  outbound commitments to this counterparty. Housekeeping snapshot
 *  (24h cadence + cascade invalidation on commitment.state_changed). */
export interface OutboundCommitmentOverdueCountValue {
  count: number;
  oldest_overdue_at: number | null;
  computed_at: number;
}

const OutboundCommitmentOverdueCountSchema: EnrichmentValueValidator<OutboundCommitmentOverdueCountValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.count)) issues.push("field 'count' must be a finite number");
  if (obj.oldest_overdue_at !== null && !isNumber(obj.oldest_overdue_at)) {
    issues.push("field 'oldest_overdue_at' must be a finite number or null");
  }
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as OutboundCommitmentOverdueCountValue };
};

/** `task_signal_density_per_thread` — per-thread density of task
 *  signals (mentions, asks, follow-ups). Reactive on thread updates. */
export interface TaskSignalDensityValue {
  density: number;
  signal_count: number;
  computed_at: number;
}

const TaskSignalDensitySchema: EnrichmentValueValidator<TaskSignalDensityValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.density)) issues.push("field 'density' must be a finite number");
  if (!isNumber(obj.signal_count)) issues.push("field 'signal_count' must be a finite number");
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as TaskSignalDensityValue };
};

/** `project_stall_signal` — per-project stall detection. Snapshot. */
export interface ProjectStallSignalValue {
  stalled: boolean;
  signals: string[];
  last_activity_at: number | null;
  computed_at: number;
}

const ProjectStallSignalSchema: EnrichmentValueValidator<ProjectStallSignalValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof obj.stalled !== 'boolean') issues.push("field 'stalled' must be a boolean");
  if (!isStringArray(obj.signals)) issues.push("field 'signals' must be string[]");
  if (obj.last_activity_at !== null && !isNumber(obj.last_activity_at)) {
    issues.push("field 'last_activity_at' must be a finite number or null");
  }
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as ProjectStallSignalValue };
};

/** `note_relevance_decay` — per-note recency-weighted relevance score. */
export interface NoteRelevanceDecayValue {
  decay_score: number;
  last_access_at: number | null;
  computed_at: number;
}

const NoteRelevanceDecaySchema: EnrichmentValueValidator<NoteRelevanceDecayValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.decay_score)) issues.push("field 'decay_score' must be a finite number");
  if (obj.last_access_at !== null && !isNumber(obj.last_access_at)) {
    issues.push("field 'last_access_at' must be a finite number or null");
  }
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as NoteRelevanceDecayValue };
};

/** `open_loop_pressure` — per-contact OR per-project pressure signal. */
export interface OpenLoopPressureValue {
  pressure_score: number;
  open_count: number;
  age_weighted_score: number;
  computed_at: number;
}

const OpenLoopPressureSchema: EnrichmentValueValidator<OpenLoopPressureValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isNumber(obj.pressure_score)) issues.push("field 'pressure_score' must be a finite number");
  if (!isNumber(obj.open_count)) issues.push("field 'open_count' must be a finite number");
  if (!isNumber(obj.age_weighted_score)) issues.push("field 'age_weighted_score' must be a finite number");
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as OpenLoopPressureValue };
};

/** `commitment_reliability_band` — banded over `commitment_followthrough_score`. */
export const COMMITMENT_RELIABILITY_BANDS = [
  'insufficient_data',
  'reliable',
  'mixed',
  'risky',
] as const;
export type CommitmentReliabilityBand = typeof COMMITMENT_RELIABILITY_BANDS[number];
const COMMITMENT_RELIABILITY_BAND_SET: ReadonlySet<string> = new Set(COMMITMENT_RELIABILITY_BANDS);
const isCommitmentReliabilityBand = (v: unknown): boolean =>
  typeof v === 'string' && COMMITMENT_RELIABILITY_BAND_SET.has(v);

export interface CommitmentReliabilityBandValue {
  band: CommitmentReliabilityBand;
  source_score: number | null;
  computed_at: number;
}

const CommitmentReliabilityBandSchema: EnrichmentValueValidator<CommitmentReliabilityBandValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isCommitmentReliabilityBand(obj.band)) {
    issues.push(`field 'band' must be one of ${COMMITMENT_RELIABILITY_BANDS.join(' / ')}`);
  }
  if (obj.source_score !== null && !isNumber(obj.source_score)) {
    issues.push("field 'source_score' must be a finite number or null");
  }
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as CommitmentReliabilityBandValue };
};

/** `preferred_channel_by_contact` — closed-list channel preference
 *  derived from observed response patterns. Behavioural, not sentiment
 *  (per spec § A.1.5 narrow taxonomy). */
export const PREFERRED_CHANNELS = [
  'email_preferred',
  'call_preferred',
  'text_preferred',
  'meeting_preferred',
  'mixed_no_clear_preference',
] as const;
export type PreferredChannel = typeof PREFERRED_CHANNELS[number];
const PREFERRED_CHANNEL_SET: ReadonlySet<string> = new Set(PREFERRED_CHANNELS);
const isPreferredChannel = (v: unknown): boolean =>
  typeof v === 'string' && PREFERRED_CHANNEL_SET.has(v);

export interface PreferredChannelByContactValue {
  preference: PreferredChannel;
  score_breakdown: Record<string, number>;
  computed_at: number;
}

const PreferredChannelByContactSchema: EnrichmentValueValidator<PreferredChannelByContactValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isPreferredChannel(obj.preference)) {
    issues.push(`field 'preference' must be one of ${PREFERRED_CHANNELS.join(' / ')}`);
  }
  if (
    obj.score_breakdown === null
    || typeof obj.score_breakdown !== 'object'
    || Array.isArray(obj.score_breakdown)
  ) {
    issues.push("field 'score_breakdown' must be a Record<string, number>");
  } else {
    for (const [k, v] of Object.entries(obj.score_breakdown as Record<string, unknown>)) {
      if (!isNumber(v)) {
        issues.push(`field 'score_breakdown.${k}' must be a finite number`);
      }
    }
  }
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as PreferredChannelByContactValue };
};

/** `project_next_action_gap` — flags active projects with no open task,
 *  pending commitment, or recent note. Snapshot. */
export interface ProjectNextActionGapValue {
  gap_present: boolean;
  gap_signals: string[];
  computed_at: number;
}

const ProjectNextActionGapSchema: EnrichmentValueValidator<ProjectNextActionGapValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof obj.gap_present !== 'boolean') issues.push("field 'gap_present' must be a boolean");
  if (!isStringArray(obj.gap_signals)) issues.push("field 'gap_signals' must be string[]");
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as ProjectNextActionGapValue };
};

/** `task_duplicate_candidate` — per-task tracker of likely duplicate
 *  tasks across Sources. Confidence is a closed-list dedupe band. */
export const TASK_DEDUPE_CONFIDENCES = [
  'exact',
  'probable',
  'low',
] as const;
export type TaskDedupeConfidence = typeof TASK_DEDUPE_CONFIDENCES[number];
const TASK_DEDUPE_CONFIDENCE_SET: ReadonlySet<string> = new Set(TASK_DEDUPE_CONFIDENCES);
const isTaskDedupeConfidence = (v: unknown): boolean =>
  typeof v === 'string' && TASK_DEDUPE_CONFIDENCE_SET.has(v);

export interface TaskDuplicateCandidateValue {
  duplicate_candidate_set: string[];
  dedupe_confidence: TaskDedupeConfidence;
  computed_at: number;
}

const TaskDuplicateCandidateSchema: EnrichmentValueValidator<TaskDuplicateCandidateValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (!isStringArray(obj.duplicate_candidate_set)) {
    issues.push("field 'duplicate_candidate_set' must be string[]");
  }
  if (!isTaskDedupeConfidence(obj.dedupe_confidence)) {
    issues.push(`field 'dedupe_confidence' must be one of ${TASK_DEDUPE_CONFIDENCES.join(' / ')}`);
  }
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as TaskDuplicateCandidateValue };
};

/** `source_freshness_degradation` — per-Source health signal. Reasons
 *  are typed as `SourceDegradationReason[]` per D-145 PA9 spec § A.7.5
 *  (the substrate-level closed list — bare strings would let producers
 *  invent ad-hoc reasons that downstream consumers can't dispatch on). */
export interface SourceFreshnessDegradationValue {
  degraded: boolean;
  reasons: SourceDegradationReason[];
  last_seen_at: number | null;
  computed_at: number;
}

const SourceFreshnessDegradationSchema: EnrichmentValueValidator<SourceFreshnessDegradationValue> = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: ['expected object'] };
  }
  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof obj.degraded !== 'boolean') issues.push("field 'degraded' must be a boolean");
  if (!Array.isArray(obj.reasons)) {
    issues.push("field 'reasons' must be SourceDegradationReason[]");
  } else {
    for (let i = 0; i < obj.reasons.length; i++) {
      if (!isSourceDegradationReason(obj.reasons[i])) {
        issues.push(
          `field 'reasons[${i}]' (${JSON.stringify(obj.reasons[i])}) is not a registered SourceDegradationReason`,
        );
      }
    }
  }
  if (obj.last_seen_at !== null && !isNumber(obj.last_seen_at)) {
    issues.push("field 'last_seen_at' must be a finite number or null");
  }
  if (!isNumber(obj.computed_at)) issues.push("field 'computed_at' must be a finite number");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: obj as unknown as SourceFreshnessDegradationValue };
};

// ────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────

// D-136 §A.5 — identity-extractor sentinels. P1 ships these as
// presence-only placeholders so the validator gate fires; P5 wires
// them into the cascade engine when cascadeForIdentityChange lands.
// `record` shapes vary by source collection — placeholders return
// best-effort canonical keys based on common field names.

/** Per-contact perspective topics: keyed on canonical email. */
const extractContactIdentity: IdentityExtractor = (record) => {
  const r = record as { canonical_email?: string; email?: string };
  return r.canonical_email ?? r.email ?? '';
};

/** Calendar-derived perspective topics: fan-in on the event's
 *  attendee emails (each attendee is a separate perspective key). */
const extractCalendarAttendees: IdentityExtractor = (record) => {
  const r = record as { attendees?: ReadonlyArray<string> };
  return Array.isArray(r.attendees) ? [...r.attendees] : [];
};

/** Mail-derived perspective topics (semantic_cluster / topic_cluster):
 *  keyed on thread_id so cascade flips when any message in the
 *  thread updates. */
const extractMailThreadIdentity: IdentityExtractor = (record) => {
  const r = record as { thread_id?: string };
  return r.thread_id ?? '';
};

/** Domain-keyed perspective topic (organization). */
const extractContactDomain: IdentityExtractor = (record) => {
  const r = record as { domain?: string; canonical_email?: string };
  if (r.domain) return r.domain;
  const email = r.canonical_email ?? '';
  const at = email.indexOf('@');
  return at > 0 ? email.slice(at + 1) : '';
};

/** Drift-signal: keyed on the source topic whose confidence we PSI'd. */
const extractDriftSignalSourceTopic: IdentityExtractor = (record) => {
  const r = record as { source_topic?: string };
  return r.source_topic ?? '';
};

/** Reserved enrichment topic IDs + metadata. Entries with
 *  `producer_kind: 'reactive'` ship producers in D-122. Entries with
 *  `producer_kind: 'housekeeping'` ship the execution mode + the
 *  `thread_signals` canary producer in D-123; the remaining 16
 *  housekeeping topics are reserved IDs that subsequent Ds add one
 *  at a time on the same harness. The schema pre-bakes so authors
 *  writing reactive recipes today already have the validator + path
 *  rewriter for housekeeping topics, even before all producers run. */
export const ENRICHMENT_REGISTRY = {
  // ── Shape A — per-record (reactive — D-122 ships producers) ────
  contact_timeline_rollup: {
    return_shape:
      '{ contact: REF<contacts>, entries: [{ at: number, kind: string, record_id: string, summary: string }], first_at: number, last_at: number, count: number }',
    shape: 'per_record',
    valid_scopes: ['contact'],
    policy: 'aggregate',
    producer_kind: 'reactive',
    aggregates_from: ['mail', 'calendar', 'audit'],
    recompute_cadence: '6h',
    supports_unfold: true,
    value_schema: ContactTimelineRollupSchema,
    sidecar: 'none',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'perspective',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    aggregate_window_ms: 30 * 24 * 60 * 60 * 1000, // 30d
    identity_extractor: extractContactIdentity,
    inputFingerprintComposition: 'perspective_fan_in',
    compression_class: 'derived',
    name: 'Contact timeline rollup',
    description: 'Condensed recent-activity digest per contact (last 30 days mail / calendar / memory).',
    user_value: 'Cheap, MCP/chat-friendly summary of what is happening with each contact — alert recipes and AI agents read this for context without paginating through full timelines.',
  },
  calendar_event_rollup: {
    return_shape:
      '{ event_id: REF<calendar>, title: string, start_at: number, end_at: number, organizer: REF<contacts>, attendees: [REF<contacts>], related_threads: [REF<mail>], summary: string }',
    shape: 'per_record',
    valid_scopes: ['calendar'],
    policy: 'dependent',
    producer_kind: 'reactive',
    value_schema: CalendarEventRollupSchema,
    sidecar: 'none',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'ttl',
    ttl_days: 7,
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    aggregate_window_ms: 30 * 24 * 60 * 60 * 1000, // 30d
    inputFingerprintComposition: 'aggregate_window_fold',
    compression_class: 'lossy',
    name: 'Meeting context rollup',
    description: 'Meeting prep rollup for an upcoming calendar event. Pre-summarized attendee patterns, related threads, recent significant events.',
    user_value: 'Time-anchored alert recipes use this to render meeting briefs without scanning the full timeline at trigger time.',
  },
  meeting_reschedule_pattern: {
    return_shape:
      '{ contact: REF<contacts>, reschedule_count: number, cancel_count: number, last_reschedule_at: number, window_ms: number }',
    shape: 'per_record',
    valid_scopes: ['contact'],
    policy: 'aggregate',
    producer_kind: 'reactive',
    aggregates_from: ['calendar'],
    recompute_cadence: '7d',
    supports_unfold: true,
    value_schema: MeetingRescheduleSchema,
    sidecar: 'none',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'perspective',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    aggregate_window_ms: 90 * 24 * 60 * 60 * 1000, // 90d
    identity_extractor: extractContactIdentity,
    inputFingerprintComposition: 'perspective_fan_in',
    compression_class: 'derived',
    name: 'Meeting reschedule pattern',
    description: 'Per-contact tally of how often a meeting on their calendar gets moved or cancelled.',
    user_value: 'Alert recipes flag chronic reschedulers so the user can adjust expectations or proactively reach out.',
  },

  // ── Shape A — per-record (housekeeping — D-123 ships canary `thread_signals`; subsequent Ds ship the rest) ─
  thread_signals: {
    return_shape:
      '{ thread_id: REF<mail>, subject: string, message_count: number, participant_count: number, participant_contacts: [{ name: string, entity: REF<contacts> }], span_days: number, latest_received_at: number, has_unread: boolean }',
    shape: 'per_record', valid_scopes: ['mail'], policy: 'aggregate',
    aggregates_from: ['mail'], recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    // D-136 P3 follow-up: concrete schema (was `acceptObject`) so the
    // registry actually enforces the contract on recipe / upsert /
    // store-validation paths. No `window_ms` field — thread_signals
    // aggregates per-thread (folds every mail sharing thread_id),
    // not per-time-window. The 24h `recompute_cadence` is the
    // refresh interval, not a signal aperture; the audit §25.1
    // "24h" cell was a guess about the topic's design that the
    // producer code never honored. See `THREAD_SIGNALS_RETROFIT_NOTE`
    // in P3 follow-up handover.
    value_schema: ThreadSignalsSchema,
    sidecar: 'none',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    inputFingerprintComposition: 'aggregate_window_fold',
    compression_class: 'derived',
    name: 'Thread signals',
    description: 'Per-thread summary signals (message count, participant count, span, unread).',
    user_value: 'Triage thread importance without re-reading every message.',
  },
  transcript: {
    return_shape:
      '{ file: REF<file>, text: string, language: string, duration_s: number, model: string }',
    shape: 'per_record', valid_scopes: ['file'], policy: 'dependent',
    producer_kind: 'housekeeping',
    value_schema: TranscriptSchema,
    sidecar: 'none',
    default_trust_state: 'manual',
    // D-262 § B12.4 — ⚠ INERT FOR THIS TOPIC, and recorded as such rather than
    // left to read as a control. Transcription no longer routes through the
    // chat pool: it reads the dedicated `transcription_slot`, which
    // `configForTranscriptionForceLayer` does not strip at any force layer
    // (it removes `slot_1`/`slot_2`/`free_pool` by name). So there is no
    // free-vs-BYOK choice left to express here. `free_only` was retained on
    // shipped servers and is harmless for the same reason — but the DEFAULT
    // moves to the permissive value so a fresh install does not carry a
    // restriction that nothing can satisfy or enforce.
    default_pool_policy: 'free_then_byok',
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'forward_only',
    compression_class: 'derived',
    prompt_bias_hints: ['may_mistranscribe_unclear_audio'],
    name: 'File transcript',
    description: 'Voice-to-text transcript for a fixed audio file.',
    user_value: 'Search and reason over voice notes without replaying audio.',
  },
  caption: {
    return_shape:
      '{ file: REF<file>, caption: string, model: string }',
    shape: 'per_record', valid_scopes: ['file'], policy: 'dependent',
    producer_kind: 'housekeeping',
    value_schema: CaptionSchema,
    sidecar: 'none',
    default_trust_state: 'manual',
    default_pool_policy: 'free_only',
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'forward_only',
    compression_class: 'derived',
    prompt_bias_hints: ['describes_visible_content_without_full_context'],
    name: 'File caption',
    description: 'Image-to-text caption for a fixed image file.',
    user_value: 'Understand image attachments without opening each file.',
  },
  extracted_text: {
    return_shape:
      '{ file: REF<file>, text: string, page_count: number, model: string }',
    shape: 'per_record', valid_scopes: ['file'], policy: 'dependent',
    producer_kind: 'housekeeping',
    value_schema: ExtractedTextSchema,
    sidecar: 'none',
    default_trust_state: 'manual',
    default_pool_policy: 'free_only',
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'forward_only',
    compression_class: 'derived',
    prompt_bias_hints: ['ocr_may_drop_layout_or_tables'],
    name: 'File extracted text',
    description: 'Document-to-text extraction for a fixed document file.',
    user_value: 'Search and reason over document attachments without manually opening them.',
  },
  embedding: {
    return_shape: '{ dimensions: number, model: string }',
    shape: 'per_record', valid_scopes: ['mail'], policy: 'dependent',
    producer_kind: 'housekeeping',
    value_schema: EmbeddingSchema,
    sidecar: 'vector_index',
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    compression_class: 'lossless',
    name: 'Mail embedding',
    description: 'Semantic vector for mail bodies — drives similarity search + semantic clustering.',
    user_value: 'Find similar messages without exact-match keyword search.',
  },
  purpose: {
    return_shape: '{ category: string, confidence: number, reasoning: string }',
    shape: 'per_record', valid_scopes: ['mail'], policy: 'dependent',
    producer_kind: 'housekeeping',
    value_schema: acceptObject,
    sidecar: 'none',
    emits_confidence: true,
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    compression_class: 'lossy',
    prompt_bias_hints: ['closed_set_classification_no_hybrid_intent'],
    name: 'Mail purpose',
    description: 'Classified intent of an inbound message (request / update / follow-up / other).',
    user_value: 'Route messages by intent rather than rule-based filters.',
  },
  summary: {
    return_shape: '{ summary: string, key_points: [string] }',
    shape: 'per_record', valid_scopes: ['mail'], policy: 'dependent',
    producer_kind: 'housekeeping',
    value_schema: acceptObject,
    sidecar: 'fts',
    emits_confidence: true,
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    compression_class: 'lossy',
    prompt_bias_hints: ['caps_output_at_250_words', 'narrative_form_loses_quantitative_detail'],
    name: 'Mail summary',
    description: 'AI-condensed summary of a mail body — keeps the gist when the original is long.',
    user_value: 'Skim long mail at a glance; the FTS index makes summaries searchable too.',
  },
  action_items: {
    return_shape:
      '{ action_items: [{ description: string, owner: string, due: string }] }',
    shape: 'per_record', valid_scopes: ['mail'], policy: 'dependent',
    producer_kind: 'housekeeping',
    value_schema: acceptObject,
    sidecar: 'none',
    emits_confidence: true,
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    compression_class: 'lossy',
    prompt_bias_hints: ['extracts_explicit_asks_misses_implicit_obligations', 'caps_at_top_n_actions'],
    name: 'Mail action items',
    description: 'Extracted to-dos / commitments from a mail body.',
    user_value: 'Surface what each message asks of you without re-reading.',
  },
  behavioral_signature: {
    return_shape:
      '[{ entity: REF<contacts>, name: string, mail_count_window: number, mail_count_total: number, meeting_count_window: number, meeting_count_total: number, mean_reply_latency_ms: number, reply_sample_count: number, last_meeting_at: number, last_inbound_at: number, computed_at: number, window_ms: number }]',
    shape: 'per_record', valid_scopes: ['contact'], policy: 'aggregate',
    aggregates_from: ['mail', 'calendar'], recompute_cadence: '7d',
    producer_kind: 'housekeeping',
    value_schema: BehavioralSignatureSchema,
    sidecar: 'none',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'perspective',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    aggregate_window_ms: 30 * 24 * 60 * 60 * 1000, // 30d
    identity_extractor: extractContactIdentity,
    inputFingerprintComposition: 'perspective_fan_in',
    compression_class: 'derived',
    coverage_quality_threshold: 100,
    name: 'Behavioral signature',
    description: 'Per-contact patterns — typical reply latency, mail volume cadence, meeting frequency.',
    user_value: 'Tailor follow-up timing to each contact’s rhythm.',
  },
  reply_patterns: {
    return_shape:
      '{ entity: REF<contacts>, name: string, inbound_count_window: number, reply_sample_count_window: number, reply_rate_window: number, reply_sample_count: number, mean_reply_latency_ms: number, p50_reply_latency_ms: number, p95_reply_latency_ms: number, computed_at: number, window_ms: number }',
    shape: 'per_record', valid_scopes: ['contact'], policy: 'aggregate',
    aggregates_from: ['mail'], recompute_cadence: '7d',
    producer_kind: 'housekeeping',
    value_schema: ReplyPatternsSchema,
    sidecar: 'none',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'perspective',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    aggregate_window_ms: 30 * 24 * 60 * 60 * 1000, // 30d
    identity_extractor: extractContactIdentity,
    inputFingerprintComposition: 'perspective_fan_in',
    compression_class: 'derived',
    name: 'Reply patterns',
    description: 'Per-contact reply-latency distribution + typical response style.',
    user_value: 'Predict whether a thread will get a fast or slow reply.',
  },
  attendee_patterns: {
    return_shape:
      '[{ entity: REF<contacts>, name: string, events_total: number, events_window: number, top_co_attendees: [{ email: REF<contacts>, entity: REF<contacts>, name: string, count: number }], last_event_at: number, computed_at: number, window_ms: number }]',
    shape: 'per_record', valid_scopes: ['contact', 'calendar'], policy: 'aggregate',
    aggregates_from: ['calendar'], recompute_cadence: '7d',
    producer_kind: 'housekeeping',
    value_schema: AttendeePatternsSchema,
    sidecar: 'none',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'perspective',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    aggregate_window_ms: 90 * 24 * 60 * 60 * 1000, // 90d
    identity_extractor: extractContactIdentity,
    inputFingerprintComposition: 'perspective_fan_in',
    compression_class: 'derived',
    name: 'Attendee patterns',
    description: 'Co-attendance graph — which contacts cluster together on calendar events.',
    user_value: 'Spot working groups + meeting cliques that aren’t formally labelled.',
  },
  meeting_frequency: {
    return_shape:
      '{ entity: REF<contacts>, name: string, events_total: number, events_window_short: number, events_window_long: number, per_week_window_short: number, per_month_window_long: number, trend: string, last_event_at: number, computed_at: number, window_ms: number }',
    shape: 'per_record', valid_scopes: ['contact'], policy: 'aggregate',
    aggregates_from: ['calendar'], recompute_cadence: '7d',
    producer_kind: 'housekeeping',
    value_schema: MeetingFrequencySchema,
    sidecar: 'none',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'perspective',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    aggregate_window_ms: 30 * 24 * 60 * 60 * 1000, // 30d short window; long window derives as 3× in producer
    identity_extractor: extractContactIdentity,
    inputFingerprintComposition: 'perspective_fan_in',
    compression_class: 'derived',
    name: 'Meeting frequency',
    description: 'Per-contact rolling meeting cadence (per-week / per-month) plus a 90d trend signal.',
    user_value: 'Identify contacts whose meeting load is changing — a leading indicator for projects ramping up or down.',
  },
  company: {
    return_shape:
      '{ domain: string, company_name: string, source: string, domain_category: string, reasoning: string, computed_at: number }',
    shape: 'per_record', valid_scopes: ['contact'], policy: 'dependent',
    producer_kind: 'housekeeping',
    value_schema: CompanySchema,
    sidecar: 'none',
    default_trust_state: 'manual',
    default_pool_policy: 'free_only',
    temporal_class: 'time_bound',
    identity_aggregation: 'perspective',
    lifecycle_policy: 'historical',
    as_of_field: 'computed_at',
    identity_extractor: extractContactIdentity,
    inputFingerprintComposition: 'perspective_fan_in',
    compression_class: 'derived',
    prompt_bias_hints: ['prefers_signature_block_evidence_over_inference', 'falls_back_to_email_domain_when_no_signature'],
    name: 'Company',
    description: 'Inferred employer for a contact, derived from email domain + AI signature parsing.',
    user_value: 'Group contacts by org without manual tagging.',
  },
  role: {
    return_shape: '{ title: string, category: string, reasoning: string, computed_at: number }',
    shape: 'per_record', valid_scopes: ['contact'], policy: 'dependent',
    producer_kind: 'housekeeping',
    value_schema: RoleSchema,
    sidecar: 'none',
    default_trust_state: 'manual',
    default_pool_policy: 'free_only',
    temporal_class: 'time_bound',
    identity_aggregation: 'perspective',
    lifecycle_policy: 'historical',
    as_of_field: 'computed_at',
    identity_extractor: extractContactIdentity,
    inputFingerprintComposition: 'perspective_fan_in',
    compression_class: 'derived',
    prompt_bias_hints: ['prefers_signature_block_evidence_over_inference', 'closed_set_role_categories'],
    name: 'Role',
    description: 'Inferred job title + role category from a contact’s mail signatures.',
    user_value: 'Filter by role when a domain has many contacts (engineering vs. sales).',
  },
  preparation_notes: {
    return_shape:
      '{ summary: string, key_points: [string], attendees_considered: [REF<contacts>], corpus_size: number, computed_at: number }',
    shape: 'per_record', valid_scopes: ['calendar'], policy: 'dependent',
    producer_kind: 'housekeeping',
    value_schema: PreparationNotesSchema,
    sidecar: 'fts',
    default_trust_state: 'manual',
    default_pool_policy: 'free_only',
    temporal_class: 'time_bound',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'ttl',
    ttl_days: 30,
    as_of_field: 'computed_at',
    compression_class: 'lossy',
    prompt_bias_hints: ['summarizes_corpus_through_llm_compression', 'caps_at_5_bullets'],
    name: 'Meeting preparation notes',
    description: 'Pre-event prep distilled from prior threads + memory mentioning the attendees.',
    user_value: 'Walk into a meeting with the relevant context surfaced automatically.',
  },
  related_threads: {
    return_shape:
      '{ threads: [{ thread_id: REF<mail>, subject: string, last_message_at: number, overlap_count: number, relevance: string, source: string, reasoning: string }], candidate_count: number, ai_invoked: boolean, computed_at: number }',
    shape: 'per_record', valid_scopes: ['calendar'], policy: 'dependent',
    producer_kind: 'housekeeping',
    value_schema: RelatedThreadsSchema,
    sidecar: 'none',
    default_trust_state: 'manual',
    default_pool_policy: 'free_only',
    temporal_class: 'time_bound',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'ttl',
    ttl_days: 30,
    as_of_field: 'computed_at',
    compression_class: 'derived',
    name: 'Related threads',
    description: 'Mail threads detected as topically related to a calendar event.',
    user_value: 'Pull the thread history into the meeting brief automatically.',
  },

  // ── Shape A — per-record (connection.* — D-125 P6.1 reserved) ──
  // Reserved housekeeping topics for connection-record enrichments.
  // Producers ship post-D-123 on the housekeeping harness; the IDs
  // are pre-baked here so that P6.2's `enrichment-or-fetch` transform
  // + lint rule already accept refs against them and the validator's
  // per-scope topic catalog surfaces the future producers in tooltips
  // today.
  connection_health_trend: {
    return_shape:
      '{ call_count: number, error_count: number, error_rate: number, latency_p50_ms: number, latency_p95_ms: number, last_call_at: number, last_failure: { ts: number, error_code: string, error_message: string }, window_ms: number, computed_at: number }',
    shape: 'per_record',
    valid_scopes: ['connection.api', 'connection.mcp', 'connection.notification'],
    policy: 'aggregate',
    aggregates_from: ['audit'],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: ConnectionHealthTrendSchema,
    sidecar: 'none',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'ingestion_time',
    inputFingerprintComposition: 'aggregate_window_fold',
    compression_class: 'derived',
    name: 'Connection health trend',
    description: 'Rolling health signal per connection record — error rate, latency p50/p95, last-failure cause.',
    user_value: 'Spot a flaky connection before a recipe fails on it; surfaced inline on the Connections page.',
    tags: ['department:eng'],
  },
  connection_last_used_pattern: {
    return_shape:
      '{ call_count: number, last_used_at: number, recipes: [{ recipe_id: string, call_count: number, last_used_at: number }], distinct_recipes: number, unattributed_call_count: number, hour_histogram: [number], window_ms: number, computed_at: number }',
    shape: 'per_record',
    valid_scopes: ['connection.api', 'connection.mcp', 'connection.notification'],
    policy: 'aggregate',
    aggregates_from: ['audit'],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: ConnectionLastUsedPatternSchema,
    sidecar: 'none',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'ingestion_time',
    inputFingerprintComposition: 'aggregate_window_fold',
    compression_class: 'derived',
    name: 'Connection last-used pattern',
    description: 'Per-connection cadence of recipe usage — how often, by which recipes, at what hours.',
    user_value: 'Surface idle connections that can be retired; size pool / refresh cadence to actual usage.',
    tags: ['department:eng'],
  },
  connection_optimal_batch_size: {
    return_shape:
      '{ sample_count: number, median_duration_ms: number, p95_duration_ms: number, median_payload_bytes: number, p95_payload_bytes: number, recommended_max_payload_bytes: number, bytes_coverage: number, window_ms: number, computed_at: number }',
    shape: 'per_record',
    valid_scopes: ['connection.api', 'connection.mcp'],
    policy: 'aggregate',
    aggregates_from: ['audit'],
    recompute_cadence: '7d',
    producer_kind: 'housekeeping',
    value_schema: ConnectionOptimalBatchSizeSchema,
    sidecar: 'none',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'ingestion_time',
    inputFingerprintComposition: 'aggregate_window_fold',
    compression_class: 'derived',
    name: 'Connection optimal batch size',
    description: 'Inferred batch size that balances throughput against rate-limit / timeout risk per connection.',
    user_value: 'Recipes auto-tune fan-out without a config knob; learns the right batch from observed responses.',
    tags: ['department:eng'],
  },

  // ── Shape A — per-record (platform-reference — D-128 P4 reserved) ──
  // Cross-vendor topics that ship on the reconciliation harness +
  // platform-reference scope shape (`connection.api.<vendor>.<entity>`).
  // Producers land in D-129 (HubSpot) / D-130 (Salesforce) — D-128
  // ships the topic IDs + value schemas + valid_scopes so the
  // validator + lint rule + Memory tab schema accept refs against
  // `data.enrichment.connection.api.hubspot.deal.<id>.deal_health_score`
  // (etc.) before any producer runs. `valid_scopes` lists every
  // platform-reference scope the topic SUPPORTS; the per-`(vendor,
  // entity)` registry (`CONNECTION_VENDOR_ENTITIES`) gates which
  // scopes actually exist at runtime — both checks layer.
  deal_health_score: {
    return_shape:
      '{ deal_id: string, score: number, factors: [{ name: string, impact: number, reasoning: string }], computed_at: number }',
    shape: 'per_record',
    valid_scopes: [
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
    ],
    policy: 'dependent',
    producer_kind: 'housekeeping',
    value_schema: DealHealthScoreSchema,
    sidecar: 'none',
    default_trust_state: 'manual',
    default_pool_policy: 'free_then_byok',
    temporal_class: 'time_bound',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'historical',
    as_of_field: 'computed_at',
    compression_class: 'derived',
    prompt_bias_hints: ['blends_quantitative_signals_with_qualitative_assessment', 'caps_breakdown_at_one_sentence_per_dimension'],
    name: 'Deal health score',
    description: 'AI-derived 0-100 health signal per CRM deal — synthesises stage, age, recent activity, contact engagement.',
    user_value: 'Surface deals at risk before pipeline review reveals them.',
    tags: ['department:sales'],
  },
  deal_velocity_signal: {
    return_shape:
      '{ deal_id: string, velocity: string, stage_dwell_days: number, last_movement_at: number, computed_at: number }',
    shape: 'per_record',
    valid_scopes: [
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
    ],
    policy: 'aggregate',
    aggregates_from: [
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
    ],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: DealVelocitySignalSchema,
    sidecar: 'none',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    inputFingerprintComposition: 'aggregate_window_fold',
    compression_class: 'derived',
    name: 'Deal velocity signal',
    description: 'Deterministic aggregate over recent vendor activity — accelerating / stable / stalling, plus days-in-stage.',
    user_value: 'Pipeline reviews surface stalled deals automatically; no separate report.',
    tags: ['department:sales'],
  },
  engagement_score_per_contact: {
    return_shape:
      '{ score: number, last_meaningful_touch: number, signal_breakdown: { local: number, recency: number, [vendor]: number }, trajectory: string, cursor_at: number }',
    shape: 'per_record',
    // D-192 S3 — the static mirror of the built-in `crm_alias:'contact'` scopes
    // (`scopesForCrmAlias('contact', CONNECTION_VENDOR_ENTITIES)` — NOT derived
    // here to avoid the enrichment-registry ↔ connection-vendors import cycle).
    // The declaration-driven contact walk (`engagementScoreSourceScopes`)
    // resolves the same set; keep this in lockstep when a built-in CRM contact
    // vendor is added. A pack-added CRM contact vendor is read from the live
    // registry but its scope is skipped by the cycle's valid_scopes intersection
    // until it joins this list (mirrors commitment_tracker's E2b guard).
    valid_scopes: [
      'connection.api.hubspot.contact',
      'connection.api.salesforce.contact',
      'connection.api.pipedrive.person',
    ],
    policy: 'aggregate',
    aggregates_from: [
      'mail',
      'calendar',
      'connection.api.hubspot.contact',
      'connection.api.salesforce.contact',
      'connection.api.pipedrive.person',
    ],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: EngagementScorePerContactSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    inputFingerprintComposition: 'aggregate_window_fold',
    compression_class: 'derived',
    name: 'Engagement score per contact',
    description: 'Per-CRM-contact 0-100 engagement score from mail + calendar + vendor activity. Carries per-source decomposition + recent trajectory.',
    user_value: 'Quantify contact engagement across channels without reading every thread; spot rising / falling relationships at a glance.',
    tags: ['department:sales'],
  },

  // ── Shape A — per-record (D-139 P1a.1 engagement substrate canary) ─
  // `engagement_silence_duration` is the smallest end-to-end producer
  // path on the engagement substrate: read engagement_edges for
  // edge_type='deal' rows, walk engagements, filter on Pass-4
  // evidence-quality contracts (event_at IS NOT NULL +
  // lifecycle_state IN ('point_in_time', 'completed') + authorship
  // NOT IN ('crm_automation', 'system_process') + direction =
  // 'inbound'), emit days-since-last-inbound. Validates the
  // reconciler→edges→cascade→aggregate chain end-to-end before P3
  // fans out to engagement_velocity_signal + last_meaningful_touch +
  // inbound_outbound_ratio. valid_scopes covers HubSpot + Salesforce
  // deal scopes; only HubSpot writes at P1a.1.
  engagement_silence_duration: {
    return_shape:
      '{ contact: REF<contacts>, last_engagement_at: number, silence_days: number, computed_at: number }',
    shape: 'per_record',
    valid_scopes: [
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
    ],
    policy: 'aggregate',
    // D-139 P3 widening (Codex P2 #1) — canary at P1a.1 listed only
    // `hubspot.email` (single-source for substrate validation); P3
    // fans the producer across every per-type engagement scope so
    // "days since last inbound" actually folds the full engagement
    // surface. Voice calls land via either `voice_call` (preferred
    // when probe finds VoiceCall SObject) or `call_history` (legacy)
    // per Pass-5 R5.11 — registry includes BOTH so topic-load is
    // probe-independent.
    aggregates_from: [
      'connection.api.hubspot.email',
      'connection.api.hubspot.meeting',
      'connection.api.hubspot.note',
      'connection.api.hubspot.call',
      'connection.api.hubspot.task',
      'connection.api.salesforce.task',
      'connection.api.salesforce.event',
      'connection.api.salesforce.email_message',
      'connection.api.salesforce.voice_call',
      'connection.api.salesforce.call_history',
    ],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: EngagementSilenceDurationSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'time_bound',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'historical',
    as_of_field: 'cursor_at',
    compression_class: 'derived',
    populates_coverage: true,
    name: 'Engagement silence duration',
    description: 'Days since the last meaningful inbound engagement on the deal. Folds the full per-type engagement surface (HubSpot 5 + Salesforce 4-5 engagement types).',
    user_value: 'Flag stalled deals before pipeline review reveals them — alert recipes fire when silence exceeds the deal stage threshold.',
    tags: ['department:sales'],
  },

  // ── Shape A — per-record (D-139 P3 deterministic deal-level) ─
  // Three additional aggregate-policy topics on the engagement
  // substrate. Each declares the full set of per-type engagement
  // scopes in `aggregates_from` (HubSpot's email/meeting/note/call/
  // task + Salesforce's task/event/email_message/call_history per
  // § A.1 / § A.2). Producers consume Pass-4 evidence-quality
  // contracts directly off `EngagementRow` (authorship + direction +
  // lifecycle_state + dedupe_confidence) — no producer-side
  // re-derivation. Trust default `'auto'` per D-132 (deterministic);
  // pool policy `'free_only'` since they cost zero tokens.

  engagement_velocity_signal: {
    return_shape:
      '{ contact: REF<contacts>, velocity: string, recent_touch_count: number, baseline_touch_count: number, change_ratio: number, computed_at: number }',
    shape: 'per_record',
    valid_scopes: [
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
    ],
    policy: 'aggregate',
    aggregates_from: [
      'connection.api.hubspot.email',
      'connection.api.hubspot.meeting',
      'connection.api.hubspot.note',
      'connection.api.hubspot.call',
      'connection.api.hubspot.task',
      'connection.api.salesforce.task',
      'connection.api.salesforce.event',
      'connection.api.salesforce.email_message',
      'connection.api.salesforce.voice_call',
      'connection.api.salesforce.call_history',
    ],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: EngagementVelocitySignalSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'forward_only',
    as_of_field: 'cursor_at',
    aggregate_window_axis: 'event_time',
    // Codex P2 #2 fold-back — velocity reads 90d of inputs (recent
    // 30d + baseline 60d) so the registry annotation must match the
    // fold window, not the recent-window subset.
    aggregate_window_ms: 90 * 24 * 60 * 60 * 1000,
    inputFingerprintComposition: 'aggregate_window_fold',
    compression_class: 'derived',
    populates_coverage: true,
    name: 'Engagement velocity signal',
    description: 'Touches/week trajectory on the deal — accelerating / steady / decaying. Recent (30d) window vs the baseline (30-90d) window; authorship-weighted (automation + system_process count at 0.25); excludes internal direction; dedupe_acceptance: exact_only.',
    user_value: 'See whether engagement is heating up or cooling off without scrolling activity timelines — alert recipes fire on decaying trajectories for high-value deals.',
    tags: ['department:sales'],
  },

  inbound_outbound_ratio: {
    return_shape:
      '{ contact: REF<contacts>, inbound_count: number, outbound_count: number, ratio: number, window_ms: number, computed_at: number }',
    shape: 'per_record',
    valid_scopes: [
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
    ],
    policy: 'aggregate',
    aggregates_from: [
      'connection.api.hubspot.email',
      'connection.api.hubspot.meeting',
      'connection.api.hubspot.note',
      'connection.api.hubspot.call',
      'connection.api.hubspot.task',
      'connection.api.salesforce.task',
      'connection.api.salesforce.event',
      'connection.api.salesforce.email_message',
      'connection.api.salesforce.voice_call',
      'connection.api.salesforce.call_history',
    ],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: InboundOutboundRatioSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'forward_only',
    as_of_field: 'cursor_at',
    aggregate_window_axis: 'event_time',
    aggregate_window_ms: 90 * 24 * 60 * 60 * 1000, // 90d full window
    inputFingerprintComposition: 'aggregate_window_fold',
    compression_class: 'derived',
    populates_coverage: true,
    name: 'Inbound/outbound ratio',
    description: 'Rep effort vs prospect engagement on the deal. Outbound counts only user / crm_user authorship; inbound excludes automation + system_process. Internal direction excluded from both buckets. Includes no_answer / failed sends as outbound effort (the rep made the attempt) but never as prospect engagement.',
    user_value: 'Spot deals where the rep is talking to themselves — high outbound + zero inbound is a stalled-deal signal.',
    tags: ['department:sales'],
  },

  last_meaningful_touch: {
    return_shape:
      '{ contact: REF<contacts>, last_touch_at: number, kind: string, record_id: string, computed_at: number }',
    shape: 'per_record',
    valid_scopes: [
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
    ],
    policy: 'aggregate',
    aggregates_from: [
      'connection.api.hubspot.email',
      'connection.api.hubspot.meeting',
      'connection.api.hubspot.note',
      'connection.api.hubspot.call',
      'connection.api.hubspot.task',
      'connection.api.salesforce.task',
      'connection.api.salesforce.event',
      'connection.api.salesforce.email_message',
      'connection.api.salesforce.voice_call',
      'connection.api.salesforce.call_history',
    ],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: LastMeaningfulTouchSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'time_bound',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'historical',
    as_of_field: 'last_touch_at',
    compression_class: 'derived',
    populates_coverage: true,
    name: 'Last meaningful touch',
    description: 'Most recent substantive engagement on the deal, filtered against tracking-pixel + workflow auto-logs. Authorship NOT IN crm_automation / system_process; excludes pending tasks, scheduled meetings, no_answer calls, failed email sends. Direction-agnostic (any meaningful inbound or outbound counts).',
    user_value: 'See the actual last meaningful touch without scrolling through opens + bounces + auto-replies — the truth about engagement recency.',
    tags: ['department:sales'],
  },

  // ── Shape A — per-record (D-139 P4 cross-entity) ────────────
  // Six cross-source aggregate-policy topics that fold engagements
  // alongside Recued local mail / calendar / CRM record meta.
  //
  // - Two deal-scoped (`meeting_to_followup_lag` +
  //   `out_of_band_engagement`): valid_scopes = HubSpot deal +
  //   Salesforce opportunity; aggregates_from spans per-type
  //   engagement scopes ∪ `mail` ∪ `calendar` (where applicable).
  // - Two account-scoped (`account_engagement_breadth` +
  //   `account_reentry_signal`): valid_scopes = HubSpot company +
  //   Salesforce account; aggregates_from spans per-type engagement
  //   scopes ∪ `mail` ∪ `calendar`.
  // - Two contact-scoped (`champion_deal_count` +
  //   `multi_account_contact`): valid_scopes = HubSpot contact +
  //   Salesforce contact; `champion_deal_count` aggregates_from
  //   spans deal/opportunity scopes + per-type engagement scopes;
  //   `multi_account_contact` aggregates_from spans contact scopes
  //   + `mail`.
  //
  // Trust default `'auto'` per D-132 (deterministic); pool policy
  // `'free_only'` since they cost zero tokens. Per Pass-4 evidence-
  // quality consumption defaults: every producer filters on
  // `direction != 'internal'` AND `lifecycle_state IN ('point_in_time',
  // 'completed')` AND `authorship NOT IN ('crm_automation',
  // 'system_process')` (with topic-specific exceptions documented on
  // each value-shape).

  meeting_to_followup_lag: {
    return_shape:
      '{ meeting_id: REF<calendar>, followup_at: number, lag_ms: number, followup_id: REF<mail>, computed_at: number }',
    shape: 'per_record',
    valid_scopes: [
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
    ],
    policy: 'aggregate',
    aggregates_from: [
      'connection.api.hubspot.email',
      'connection.api.hubspot.meeting',
      'connection.api.hubspot.note',
      'connection.api.hubspot.call',
      'connection.api.hubspot.task',
      'connection.api.salesforce.task',
      'connection.api.salesforce.event',
      'connection.api.salesforce.email_message',
      'connection.api.salesforce.voice_call',
      'connection.api.salesforce.call_history',
      'mail',
      'calendar',
    ],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: MeetingToFollowupLagSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'time_bound',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'historical',
    as_of_field: 'last_meeting_at',
    compression_class: 'derived',
    populates_coverage: true,
    name: 'Meeting → follow-up lag',
    description: 'Time from latest completed meeting → next outbound rep touch on the deal. Bucketed fast/normal/long/slipping/none. Slipping-deal signal — alerts when the rep hasn\'t followed up after a deal meeting. Folds calendar + CRM meeting evidence + mail/CRM email outbound; excludes scheduled/cancelled/rescheduled meetings + non-rep authorship.',
    user_value: 'Catch deals slipping after a meeting before pipeline review — alert recipes fire when post-meeting follow-up runs long.',
    tags: ['department:sales'],
  },

  out_of_band_engagement: {
    return_shape:
      '{ contact: REF<contacts>, channel: string, count: number, last_at: number, computed_at: number }',
    shape: 'per_record',
    valid_scopes: [
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
    ],
    policy: 'aggregate',
    aggregates_from: [
      'connection.api.hubspot.email',
      'connection.api.salesforce.email_message',
      'mail',
    ],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: OutOfBandEngagementSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'time_bound',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'historical',
    as_of_field: 'latest_unmatched_at',
    compression_class: 'derived',
    populates_coverage: true,
    name: 'Out-of-band engagement',
    description: 'Outbound rep mails to deal contacts that didn\'t land as a CRM engagement. Surfaces the visibility gap where the rep\'s real work isn\'t visible to CRM-only views. Mail-to-CRM matching prefers Message-ID; falls back to (from + to + sent_at + subject_hash) quadruple. 30-min grace window after CRM landing. Confidence gate: alerts only when contact has clear primary-deal signal.',
    user_value: 'See the deal work that isn\'t in CRM — alert recipes fire on out-of-band outbound that should be logged.',
    tags: ['department:sales'],
  },

  account_engagement_breadth: {
    return_shape:
      '{ account_id: string, distinct_contacts: number, distinct_channels: number, recent_breadth: number, computed_at: number }',
    shape: 'per_record',
    valid_scopes: [
      'connection.api.hubspot.company',
      'connection.api.salesforce.account',
    ],
    policy: 'aggregate',
    aggregates_from: [
      'connection.api.hubspot.email',
      'connection.api.hubspot.meeting',
      'connection.api.hubspot.note',
      'connection.api.hubspot.call',
      'connection.api.hubspot.task',
      'connection.api.salesforce.task',
      'connection.api.salesforce.event',
      'connection.api.salesforce.email_message',
      'connection.api.salesforce.voice_call',
      'connection.api.salesforce.call_history',
      'mail',
      'calendar',
    ],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: AccountEngagementBreadthSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'forward_only',
    as_of_field: 'cursor_at',
    aggregate_window_axis: 'event_time',
    aggregate_window_ms: 90 * 24 * 60 * 60 * 1000,
    inputFingerprintComposition: 'aggregate_window_fold',
    compression_class: 'derived',
    populates_coverage: true,
    name: 'Account engagement breadth',
    description: 'Distinct contacts at the account engaging in the recent 90d window. Recency-weighted (30d half-life per contact) — MEDDIC-flavored multi-threading read. Excludes internal direction, automation/system_process authorship, non-evidence lifecycle states.',
    user_value: 'Spot accounts with single-threaded relationships — alert recipes fire when account breadth narrows below the threshold for the deal stage.',
    tags: ['department:sales'],
  },

  account_reentry_signal: {
    return_shape:
      '{ account_id: string, last_active_at: number, reentry_at: number, silence_days: number, computed_at: number }',
    shape: 'per_record',
    valid_scopes: [
      'connection.api.hubspot.company',
      'connection.api.salesforce.account',
    ],
    policy: 'aggregate',
    aggregates_from: [
      'connection.api.hubspot.email',
      'connection.api.hubspot.meeting',
      'connection.api.hubspot.note',
      'connection.api.hubspot.call',
      'connection.api.hubspot.task',
      'connection.api.salesforce.task',
      'connection.api.salesforce.event',
      'connection.api.salesforce.email_message',
      'connection.api.salesforce.voice_call',
      'connection.api.salesforce.call_history',
      'mail',
      'calendar',
    ],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: AccountReentrySignalSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'time_bound',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'historical',
    as_of_field: 'last_reentry_at',
    compression_class: 'derived',
    populates_coverage: true,
    name: 'Account re-entry signal',
    description: 'Dormant account suddenly active in the last 14d — surfaces reactivation leads. Boolean state-at-observation (≥ 60 days zero qualifying engagement, then recent activity). Excludes internal direction, automation/system_process authorship, non-evidence lifecycle states.',
    user_value: 'Catch dormant accounts coming back into play — alert recipes fire on the reactivation, not after the rep finds out late.',
    tags: ['department:sales'],
  },

  champion_deal_count: {
    return_shape:
      '{ contact: REF<contacts>, deal_count: number, deal_ids: [string], computed_at: number }',
    shape: 'per_record',
    valid_scopes: [
      'connection.api.hubspot.contact',
      'connection.api.salesforce.contact',
    ],
    policy: 'aggregate',
    aggregates_from: [
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
      'connection.api.hubspot.email',
      'connection.api.hubspot.meeting',
      'connection.api.hubspot.note',
      'connection.api.hubspot.call',
      'connection.api.hubspot.task',
      'connection.api.salesforce.task',
      'connection.api.salesforce.event',
      'connection.api.salesforce.email_message',
      'connection.api.salesforce.voice_call',
      'connection.api.salesforce.call_history',
    ],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: ChampionDealCountSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'perspective',
    lifecycle_policy: 'forward_only',
    as_of_field: 'cursor_at',
    aggregate_window_axis: 'event_time',
    aggregate_window_ms: 365 * 24 * 60 * 60 * 1000, // 1y for win/loss patterns
    identity_extractor: extractContactIdentity,
    inputFingerprintComposition: 'perspective_fan_in',
    compression_class: 'derived',
    populates_coverage: true,
    name: 'Champion deal count',
    description: 'Per-contact count of deals the contact has touched, segmented by closed-won / closed-lost / open. Computes win_rate over the closed sample + categorical bucket (champion / mixed / blocker / unknown). Cross-deal perspective for one contact — surfaces who carries multiple wins (cultivate as advocate) vs who keeps appearing on losses (potential blocker).',
    user_value: 'See champions vs blockers across your book — alert recipes fire on contacts with patterned losses or carry your top advocates.',
    tags: ['department:sales'],
  },

  multi_account_contact: {
    return_shape:
      '{ contact: REF<contacts>, account_ids: [string], account_count: number, computed_at: number }',
    shape: 'per_record',
    valid_scopes: [
      'connection.api.hubspot.contact',
      'connection.api.salesforce.contact',
    ],
    policy: 'aggregate',
    aggregates_from: [
      'connection.api.hubspot.contact',
      'connection.api.salesforce.contact',
      'mail',
    ],
    recompute_cadence: '7d',
    producer_kind: 'housekeeping',
    value_schema: MultiAccountContactSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'time_bound',
    identity_aggregation: 'perspective',
    lifecycle_policy: 'historical',
    as_of_field: 'cursor_at',
    identity_extractor: extractContactIdentity,
    inputFingerprintComposition: 'perspective_fan_in',
    compression_class: 'derived',
    populates_coverage: true,
    name: 'Multi-account contact',
    description: 'Contact\'s professional mail domain ≠ CRM company affiliation domain — likely job change, reactivation lead. Compares canonical mail domain (excluding free-mail providers) against HubSpot company.domain or Salesforce Account.Website. Empty CRM-domain set → false (insufficient signal).',
    user_value: 'Catch contacts who changed jobs before they go cold — alert recipes fire when their mail starts coming from a different professional domain.',
    tags: ['department:sales'],
  },

  // ── Shape A — per-record (D-139 P5 AI-surface canaries) ────
  // Two AI-surface deal-scoped enrichments — `engagement_sentiment_trend`
  // (aggregate_window × scenario × forward_only) + `next_best_action`
  // (time_bound × scenario × historical). Manual trust default per
  // D-132 (`enrichment_trust.trust_state = 'manual'` until user
  // promotion at `MANUAL_RUN_THRESHOLD = 3`); free-pool default per
  // P5 spec — both topics route through the free-pool LLM resolver
  // first, fall through to BYOK only when user policy says so.
  //
  // Evidence-quality consumption defaults declared as registry
  // annotations per Pass-4 + Pass-5: `body_state_acceptance` /
  // `authorship_acceptance` / `lifecycle_state_acceptance` /
  // `dedupe_acceptance` so the producer harness can pre-filter
  // engagement rows BEFORE LLM compute (no token spend on rows the
  // producer would skip anyway).
  //
  // Cross-pool invalidation flows through `runAIProducer`'s probe-
  // model_id check — switching from free-pool to BYOK invalidates
  // cached rows because the existing row's `model_id` mismatches the
  // probed next-call model_id. Steady-state cycles cost zero tokens
  // when source rows + producer_version_hash + model_id all match.

  engagement_sentiment_trend: {
    return_shape:
      '{ contact: REF<contacts>, sentiment_baseline: number, sentiment_recent: number, trend: string, sample_count: number, computed_at: number }',
    shape: 'per_record',
    valid_scopes: [
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
    ],
    policy: 'aggregate',
    aggregates_from: [
      'connection.api.hubspot.email',
      'connection.api.hubspot.meeting',
      'connection.api.hubspot.note',
      'connection.api.hubspot.call',
      'connection.api.hubspot.task',
      'connection.api.salesforce.task',
      'connection.api.salesforce.event',
      'connection.api.salesforce.email_message',
      'connection.api.salesforce.voice_call',
      'connection.api.salesforce.call_history',
    ],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: EngagementSentimentTrendSchema,
    sidecar: 'none',
    default_trust_state: 'manual',
    default_pool_policy: 'free_only',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'forward_only',
    as_of_field: 'cursor_at',
    aggregate_window_axis: 'event_time',
    aggregate_window_ms: 60 * 24 * 60 * 60 * 1000, // 60d trailing window — tone past 60d is stale
    inputFingerprintComposition: 'aggregate_window_fold',
    compression_class: 'lossy',
    populates_coverage: true,
    prompt_bias_hints: [
      'favors_recency_when_volatile',
      'caps_key_phrases_at_five',
      'tone_inferred_from_preview_when_full_body_unavailable',
    ],
    // Pass-4 evidence-quality consumption defaults — substrate
    // contracts; producer harness pre-filters at compute time.
    body_state_acceptance: [
      'mail_link',
      'calendar_link',
      'inline_body',
      'truncated_inline',
    ],
    authorship_acceptance: ['user', 'crm_user', 'unknown'],
    lifecycle_state_acceptance: ['point_in_time', 'completed'],
    dedupe_acceptance: 'exact_only',
    name: 'Engagement sentiment trend',
    description:
      'Tone trajectory across a deal\'s recent engagement window. AI-surface; folds qualifying engagement rows (authorship NOT IN crm_automation/system_process; lifecycle in evidence states; direction-agnostic) into a closed-bucket tone read + score in [-1, 1] + up to 5 short key-phrase tokens. Persists scalar derivatives only — never raw body text.',
    user_value:
      'See whether the deal\'s tone is warming, cooling, or volatile without scrolling activity timelines — recipe alerts fire on cooling deals before the rep notices.',
    tags: ['department:sales'],
  },

  next_best_action: {
    return_shape:
      '{ contact: REF<contacts>, action: string, priority: string, reasoning: string, computed_at: number }',
    shape: 'per_record',
    valid_scopes: [
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
    ],
    policy: 'aggregate',
    aggregates_from: [
      'connection.api.hubspot.email',
      'connection.api.hubspot.meeting',
      'connection.api.hubspot.note',
      'connection.api.hubspot.call',
      'connection.api.hubspot.task',
      'connection.api.salesforce.task',
      'connection.api.salesforce.event',
      'connection.api.salesforce.email_message',
      'connection.api.salesforce.voice_call',
      'connection.api.salesforce.call_history',
    ],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: NextBestActionSchema,
    sidecar: 'none',
    default_trust_state: 'manual',
    default_pool_policy: 'free_only',
    temporal_class: 'time_bound',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'historical',
    as_of_field: 'computed_at',
    aggregate_window_ms: 60 * 24 * 60 * 60 * 1000, // 60d producer read window for fingerprint composition
    inputFingerprintComposition: 'aggregate_window_fold',
    compression_class: 'derived',
    populates_coverage: true,
    prompt_bias_hints: [
      'favors_conservative_action_when_uncertain',
      'wait_when_signal_insufficient',
      'caps_rationale_at_one_sentence',
    ],
    // Pass-4 evidence-quality consumption defaults — NBA's body-state
    // acceptance is tighter than sentiment's: tone-from-preview is
    // partial-but-useful but action recommendation needs full body
    // context (the LLM otherwise hallucinates "schedule meeting" on
    // every deal with a one-line preview).
    body_state_acceptance: ['mail_link', 'calendar_link', 'inline_body'],
    authorship_acceptance: ['user', 'crm_user', 'unknown'],
    lifecycle_state_acceptance: ['point_in_time', 'completed'],
    dedupe_acceptance: 'exact_only',
    name: 'Next best action',
    description:
      'Recommendation derived from the deal\'s recent engagement context. AI-surface; closed action bucket (send_email / schedule_meeting / wait / investigate / escalate / review_contact / no_action) + confidence in [0, 1] + ≤ 200-char rationale. Skips truncated-inline body rows (full body context required for action recommendation). Persists scalar values only.',
    user_value:
      'Get a quick "what should I do next on this deal" read backed by mail + meetings + CRM activity — recipes can dispatch on the action enum or surface the rationale in a daily digest.',
    tags: ['department:sales'],
  },

  // ── Shape A — per-record (D-139 P6.B post-substrate canary) ────
  // Privacy-tier separated from the deterministic P6.A pack — extracts
  // mail / calendar / memory body content to identify commitments
  // people made. Per spec § A.9.2c lifecycle is `time_bound × perspective`
  // (commitments expire / fulfill / break; per-contact perspective).
  // Storage: per-record contact-scoped row; the `commitments[]` value
  // carries deal/account context via D-120 link-graph `evidence_links`.
  // Cascade fans on contact identity per `extractContactIdentity`.
  //
  // Authorship-filtered (per Pass-4 R4.1) — extracts ONLY from
  // `authorship IN ('user', 'crm_user', 'unknown')` rows;
  // `'crm_automation'` + `'system_process'` rows can't make commitments.
  //
  // Body-state acceptance is tighter than the AI-surface canaries
  // (sentiment + NBA): commitment_tracker requires `'inline_body'` only
  // (full-context required for accurate extraction; truncated previews
  // silently drop the very fragments where the commitment phrase lives).
  //
  // Lifecycle-state acceptance: `'point_in_time'` + `'completed'` only
  // — pending tasks + scheduled meetings + cancelled rows + failed sends
  // + no-answer calls have no body content suitable for commitment
  // extraction.
  //
  // Dedupe acceptance: `'exact_only'` — never collapse probable-twin
  // emails into one commitment (would conflate two distinct
  // commitments per Pass-5 R5.12).
  //
  // Trust + pool defaults: manual trust per D-132 (AI-surface;
  // user must promote at MANUAL_RUN_THRESHOLD); free-pool first per
  // P6.B spec (cost-recovery rationale — commitment text generation
  // is bounded, low-token; routing through the user's free-tier pool
  // before BYOK keeps the pack cost-neutral by default).

  commitment_tracker: {
    return_shape:
      '{ commitments: [{ description: string, owner: REF<contacts>, due_at: number, status: string, source_record: string }], computed_at: number }',
    shape: 'per_record',
    // D-192 E2b — the static mirror of the built-in `crm_alias:'contact'`
    // scopes (`scopesForCrmAlias('contact', CONNECTION_VENDOR_ENTITIES)` —
    // NOT derived here to avoid the enrichment-registry ↔ connection-vendors
    // import cycle). The declaration-driven contact walk resolves the same
    // set; keep this in lockstep when a built-in CRM contact vendor is added.
    // A pack-added CRM contact vendor is walked (live registry) but its
    // upsert is skipped here until its scope joins this list (the cycle's
    // per-contact guard swallows the scope-unsupported reject).
    valid_scopes: [
      'connection.api.hubspot.contact',
      'connection.api.salesforce.contact',
      'connection.api.pipedrive.person',
    ],
    policy: 'aggregate',
    aggregates_from: [
      'mail',
      'calendar',
      'audit',
      'connection.api.hubspot.email',
      'connection.api.hubspot.meeting',
      'connection.api.hubspot.note',
      'connection.api.hubspot.call',
      'connection.api.hubspot.task',
      'connection.api.salesforce.task',
      'connection.api.salesforce.event',
      'connection.api.salesforce.email_message',
      'connection.api.salesforce.voice_call',
      'connection.api.salesforce.call_history',
    ],
    recompute_cadence: '24h',
    // D-192 email flagship (E2b) — reconciled 'reactive' → 'housekeeping':
    // the reactive AI dispatch harness never shipped, so commitment_tracker
    // runs as a standalone housekeeping task (the declaration-driven contact
    // walk in commitment-tracker-task.ts, registered in STANDALONE_TASKS).
    // `default_trust_state: 'manual'` below is honored either way
    // (resolveEnrichmentTrustDefault returns the explicit value first).
    producer_kind: 'housekeeping',
    value_schema: CommitmentTrackerSchema,
    sidecar: 'none',
    default_trust_state: 'manual',
    default_pool_policy: 'free_only',
    temporal_class: 'time_bound',
    identity_aggregation: 'perspective',
    lifecycle_policy: 'historical',
    as_of_field: 'computed_at',
    identity_extractor: extractContactIdentity,
    inputFingerprintComposition: 'perspective_fan_in',
    compression_class: 'derived',
    populates_coverage: true,
    prompt_bias_hints: [
      'caps_text_at_short_paraphrase',
      'rejects_speculative_commitments',
      'requires_explicit_due_phrasing',
      'never_extracts_from_automation_authored_rows',
      'evidence_links_required_for_every_commitment',
    ],
    body_state_acceptance: ['inline_body'],
    authorship_acceptance: ['user', 'crm_user', 'unknown'],
    lifecycle_state_acceptance: ['point_in_time', 'completed'],
    dedupe_acceptance: 'exact_only',
    name: 'Commitment tracker',
    description:
      'Commitments ("you said you\'d send X by Friday") extracted from mail / calendar / memory / CRM engagements. Authorship-filtered (user / crm_user / unknown only — automation/system_process rows can\'t make commitments). Body-state requires inline_body (full-context required for accurate extraction; truncated previews skipped). Per-contact perspective: row keyed on canonical contact email; deal/account context lives in D-120 link-graph evidence_links. AI-surface; manual trust default per D-132 — user must promote after MANUAL_RUN_THRESHOLD runs. Privacy-tier separated from the deterministic P6.A pack: ships in the post-substrate-canary `crm-commitment-tracker` pack which carries an implicit MCP body-content permission grant on install per spec § A.9.5.',
    user_value:
      'Track follow-through across mail / calendar / memory — the alert recipe fires when a commitment\'s due date approaches and the commitment is still pending, so users can keep their word without manually scanning timelines.',
    tags: ['department:sales', 'domain:crm', 'kind:ai_surface', 'shape:per_record'],
  },

  // ── Shape A — per-record (HubSpot-flavored — D-129 P6) ─────
  // HubSpot-only topics shipped alongside the cross-vendor reservations
  // above. Producers ship as standalone housekeeping tasks (one task
  // walking every `connection.api.hubspot.<entity>` row in
  // `data_enrichment`) rather than per-record producers — the harness's
  // PerRecordWalkerKind set covers `mail` / `contact` / `calendar`
  // walkers, not platform-reference scopes which live exclusively in
  // the enrichment table itself.
  lifecycle_stage_inferred: {
    return_shape:
      '{ stage: string, reasoning: string, signals: [string], computed_at: number }',
    shape: 'per_record',
    valid_scopes: ['connection.api.hubspot.contact'],
    policy: 'dependent',
    producer_kind: 'housekeeping',
    value_schema: LifecycleStageInferredSchema,
    sidecar: 'none',
    default_trust_state: 'manual',
    default_pool_policy: 'free_then_byok',
    temporal_class: 'time_bound',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'historical',
    as_of_field: 'computed_at',
    compression_class: 'derived',
    prompt_bias_hints: ['favors_conservative_classification_when_uncertain', 'caps_reasoning_at_one_sentence'],
    name: 'Inferred lifecycle stage (HubSpot)',
    description: 'AI-classified lifecycle stage for a HubSpot contact. Normalised vocabulary, derived from contact meta + Recued local mail/calendar activity.',
    user_value: 'Surface the gap when your HubSpot lifecyclestage drifts away from observed engagement; flag contacts who are acting more advanced (or less) than HubSpot says.',
    tags: ['department:sales', 'platform:hubspot'],
  },
  attribution_signal: {
    return_shape:
      '{ first_touch_source: string, first_touch_at: number, first_touch_channel: string, signals: [string], computed_at: number }',
    shape: 'per_record',
    valid_scopes: [
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
    ],
    policy: 'dependent',
    producer_kind: 'housekeeping',
    value_schema: AttributionSignalSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'forward_only',
    compression_class: 'lossless',
    name: 'Deal attribution signal',
    description: 'First-touch attribution per CRM deal. Deterministic join of deal create + linked contacts + Recued mail timeline; cross-vendor (HubSpot deals + Salesforce opportunities).',
    user_value: 'See where each deal originated without manual UTM tracking — backed by mail/calendar evidence rather than self-reported source fields.',
    tags: ['department:sales'],
  },
  lifecycle_stage_inferred_salesforce: {
    shape: 'per_record',
    valid_scopes: ['connection.api.salesforce.contact'],
    policy: 'dependent',
    producer_kind: 'housekeeping',
    value_schema: LifecycleStageInferredSalesforceSchema,
    sidecar: 'none',
    default_trust_state: 'manual',
    default_pool_policy: 'free_then_byok',
    temporal_class: 'time_bound',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'historical',
    as_of_field: 'computed_at',
    compression_class: 'derived',
    prompt_bias_hints: ['favors_conservative_classification_when_uncertain', 'caps_reasoning_at_one_sentence'],
    name: 'Inferred lifecycle stage (Salesforce)',
    description: 'AI-classified lifecycle stage for a Salesforce contact. Normalised vocabulary, derived from contact meta + Recued local mail/calendar activity. Parallel to the HubSpot-flavored `lifecycle_stage_inferred` topic — Salesforce vocabulary diverges (Lead / Prospect / Customer / Prior Customer / Partner / Other).',
    user_value: 'Surface the gap when your Salesforce lifecycle setting drifts from observed engagement; flag contacts who are acting more advanced (or less) than Salesforce says.',
    tags: ['department:sales', 'platform:salesforce'],
  },

  // ── Shape A — per-record (D-145 PA9 work-entity producers, 8) ───
  // Spec § A.7.1. Substrate-shipped producers operating on the four
  // canonical work entities (commitment / task / note / project).
  // 3 PSI-eligible producers carry `emits_confidence: true` —
  // `commitment_followthrough_score`, `task_completion_velocity`,
  // `project_velocity` — so D-133 drift detection picks them up.
  // All 8 default to `'auto'` trust state per D-132 (deterministic
  // + band-derived; PSI calibration is the producer-version drift
  // signal, not an LLM-call cost).

  commitment_followthrough_score: {
    shape: 'per_record',
    valid_scopes: ['contact'],
    policy: 'aggregate',
    aggregates_from: ['contact', 'commitment'],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: PsiEligibleScoreSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    emits_confidence: true,
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    compression_class: 'derived',
    name: 'Commitment follow-through score',
    description: 'Per-contact follow-through score derived from inbound commitment fulfilment patterns over the rolling window. PSI-eligible — D-133 drift detection catches when the score distribution silently regresses across producer-version bumps.',
    user_value: 'Quantify how reliably each contact follows through on what they say they\'ll do.',
    tags: ['department:work'],
  },
  commitment_imbalance: {
    shape: 'per_record',
    valid_scopes: ['contact'],
    policy: 'aggregate',
    aggregates_from: ['commitment'],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: CommitmentImbalanceSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    aggregate_window_ms: 90 * 24 * 60 * 60 * 1000,
    inputFingerprintComposition: 'aggregate_window_fold',
    compression_class: 'derived',
    name: 'Commitment imbalance',
    description: 'Per-relationship signal of inbound-vs-outbound commitment skew. Surfaces relationships where one side is making far more commitments than the other.',
    user_value: 'Spot one-sided relationships before they become resentful.',
    tags: ['department:work'],
  },
  outbound_commitment_overdue_count: {
    shape: 'per_record',
    valid_scopes: ['contact'],
    policy: 'aggregate',
    aggregates_from: ['commitment'],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: OutboundCommitmentOverdueCountSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    compression_class: 'derived',
    name: 'Outbound commitment overdue count',
    description: 'Per-contact snapshot of overdue outbound commitments to this counterparty. Recomputes daily; cascade-invalidates on commitment.state_changed via the standard work-entity due-status sweep. Spec § A.7.1 framed this as "per-pair (boss-level)"; the D-145 PA9 implementation slice ships per-contact rows so engine + alert recipes can surface per-counterparty growth.',
    user_value: 'Spot counterparties whose overdue queue is growing — alert recipes fire on per-contact growth.',
    tags: ['department:work'],
  },
  task_completion_velocity: {
    shape: 'per_record',
    valid_scopes: ['contact'],
    policy: 'aggregate',
    aggregates_from: ['task'],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: PsiEligibleScoreSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    emits_confidence: true,
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    compression_class: 'derived',
    name: 'Task completion velocity',
    description: 'Per-contact tasks-completed-per-period over the rolling window. PSI-eligible.',
    user_value: 'Spot contacts whose throughput is changing — leading indicator for projects ramping up or down.',
    tags: ['department:work'],
  },
  task_signal_density_per_thread: {
    shape: 'per_record',
    valid_scopes: ['mail'],
    policy: 'aggregate',
    aggregates_from: ['task', 'mail'],
    recompute_cadence: '24h',
    // Implementation ships under housekeeping. The cascade-driven
    // stale-sweep picks up fresh density values within one cycle of any
    // `data.mail.received` or `data.task.created` event — no separate
    // reactive harness needed. Same precedent as
    // `outbound_commitment_overdue_count` + `commitment_imbalance`.
    producer_kind: 'housekeeping',
    value_schema: TaskSignalDensitySchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    aggregate_window_ms: 30 * 24 * 60 * 60 * 1000,
    inputFingerprintComposition: 'aggregate_window_fold',
    compression_class: 'derived',
    name: 'Task signal density per thread',
    description: 'Per-thread density of task signals (mentions, asks, follow-ups). Reactive on thread updates.',
    user_value: 'Triage threads by how much real work they encode without re-reading messages.',
    tags: ['department:work'],
  },
  project_stall_signal: {
    shape: 'per_record',
    valid_scopes: ['project'],
    policy: 'aggregate',
    aggregates_from: ['project', 'task', 'note', 'commitment'],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: ProjectStallSignalSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    compression_class: 'derived',
    name: 'Project stall signal',
    description: 'Stalled-vs-active flag per project. Folds task / note / commitment activity into the flag with per-project signals.',
    user_value: 'Spot stalled projects without manual review.',
    tags: ['department:work'],
  },
  project_velocity: {
    shape: 'per_record',
    valid_scopes: ['project'],
    policy: 'aggregate',
    aggregates_from: ['project', 'task'],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: PsiEligibleScoreSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    emits_confidence: true,
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    compression_class: 'derived',
    name: 'Project velocity',
    description: 'Per-project completed-task velocity over the rolling window. PSI-eligible.',
    user_value: 'See whether each project is accelerating, steady, or decaying.',
    tags: ['department:work'],
  },
  note_relevance_decay: {
    shape: 'per_record',
    valid_scopes: ['note'],
    policy: 'aggregate',
    // Codex P2 note — `aggregates_from` carries cascade-walker scopes
    // only (registry-driven cascade fires on `note` row updates). The
    // declaration-side `operates_on` widens to `['data.note',
    // 'note_access_ledger']` — `note_access_ledger` is a server-internal
    // table (D-145 PA1 substrate, non-mutating note reads), not a
    // warehouse collection, so cascade doesn't dispatch on it; the
    // declaration documents it for the C.3 benchmark + producer audit.
    aggregates_from: ['note'],
    recompute_cadence: '7d',
    producer_kind: 'housekeeping',
    value_schema: NoteRelevanceDecaySchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'ingestion_time',
    aggregate_window_ms: 180 * 24 * 60 * 60 * 1000,
    inputFingerprintComposition: 'aggregate_window_fold',
    compression_class: 'derived',
    name: 'Note relevance decay',
    description: 'Per-note recency-weighted relevance score — decays without access. Drives the `note-relevance` recipe surface.',
    user_value: 'Surface notes whose relevance is fading so they can be archived or refreshed.',
    tags: ['department:work'],
  },

  // ── Shape A/B — D-145 PA9 engine + reliability producers, 8 ─────
  // Spec § A.7.2. Engine + reliability producers feed the Recued
  // engine directly + make "All Sources" reads trustworthy.
  // 1 PSI-eligible producer carries `emits_confidence: true` —
  // `context_packet_quality` (derived_entity over data_memory rows;
  // measures C.3 benchmark + future engine tuning).
  //
  // `open_loop_pressure` valid_scopes carries TWO scopes (contact +
  // project) — one producer writes both per spec § A.7.2 (math is
  // identical: count + age-weight). Substrate handles two-scope
  // dispatch via the existing `valid_scopes` array.
  //
  // `commitment_reliability_band` is `derived_band` per A.7.5 — bands
  // over `commitment_followthrough_score` via `consumes_topics`. Not
  // PSI-eligible directly (the source IS PSI-eligible).
  //
  // 3 derived_entity producers (`source_freshness_degradation`,
  // `standing_instruction_conflict`, `context_packet_quality`) key on
  // an entity that lives outside the cascade-walker's scope set —
  // policy: 'independent' for those whose source-row cascade is N/A.

  open_loop_pressure: {
    shape: 'per_record',
    valid_scopes: ['contact', 'project'],
    policy: 'aggregate',
    aggregates_from: ['commitment', 'task', 'mail'],
    recompute_cadence: '24h',
    // Implementation ships under housekeeping. The cascade-driven
    // stale-sweep picks up fresh values within one cycle of any
    // `data.commitment.state_changed` / `data.task.state_changed` /
    // `data.mail.received` event — no reactive harness needed. Same
    // precedent as `outbound_commitment_overdue_count` +
    // `commitment_imbalance` + `task_signal_density_per_thread`.
    producer_kind: 'housekeeping',
    value_schema: OpenLoopPressureSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    compression_class: 'derived',
    name: 'Open loop pressure',
    description: 'Two derived-entity scopes (per-contact + per-project) sharing one producer. Folds unresolved commitments + tasks + unanswered threads into a count + age-weighted pressure score. Engine consumes for "what needs attention?" surfaces.',
    user_value: 'See where attention is needed without scanning every entity manually.',
    tags: ['department:work'],
  },
  commitment_reliability_band: {
    shape: 'per_record',
    valid_scopes: ['contact'],
    policy: 'aggregate',
    aggregates_from: ['data_enrichment'],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    consumes_topics: ['commitment_followthrough_score'],
    value_schema: CommitmentReliabilityBandSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    compression_class: 'derived',
    name: 'Commitment reliability band',
    description: 'Commitment-reliability band per contact (insufficient_data / reliable / mixed / risky). Banded over the raw 0-1 `commitment_followthrough_score` with explicit per-band sample floors — more usable than raw scores in user-facing surfaces.',
    user_value: 'Tag contacts as reliable / mixed / risky without exposing arbitrary 0-1 floats.',
    tags: ['department:work'],
  },
  preferred_channel_by_contact: {
    shape: 'per_record',
    valid_scopes: ['contact'],
    policy: 'aggregate',
    // Codex P2 note — declaration-side `operates_on` includes
    // `data.contact.engagements` (D-139 P5 resolver path), but the
    // registry's `aggregates_from` reflects cascade-walker scopes only
    // (`mail` + `calendar`). The engagements resolver dispatches at
    // read-time across HubSpot / Salesforce per-type engagement scopes
    // — those scopes don't enter the registry's cascade list (the
    // engagements producer is the cascade source for engagement rows,
    // not this producer).
    aggregates_from: ['mail', 'calendar'],
    recompute_cadence: '7d',
    producer_kind: 'housekeeping',
    value_schema: PreferredChannelByContactSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    aggregate_window_ms: 90 * 24 * 60 * 60 * 1000,
    inputFingerprintComposition: 'aggregate_window_fold',
    compression_class: 'derived',
    name: 'Preferred channel by contact',
    description: 'Preferred outreach channel per contact (email / call / text / meeting / no clear preference). Closed-list values email_preferred / call_preferred / text_preferred / meeting_preferred / mixed_no_clear_preference; behavioral derivation from observed mail / calendar / engagement response patterns. Substrate explicitly avoids "sentiment" framing per A.1.5 narrow taxonomy.',
    user_value: 'Reach contacts where they actually respond rather than guessing.',
    tags: ['department:work'],
  },
  project_next_action_gap: {
    shape: 'per_record',
    valid_scopes: ['project'],
    policy: 'aggregate',
    aggregates_from: ['project', 'task', 'note', 'commitment'],
    recompute_cadence: '24h',
    // Spec § A.7.2 frames this as "housekeeping (daily) + reactive (on
    // child-entity state change)". The reactive harness lift is a
    // deferred follow-on; today's enrichment harness only registers
    // `'housekeeping'` producers (`buildEnrichmentProducerTask`
    // rejects `'reactive'`). Cascade staling on the declaration's
    // `invalidation_triggers` carries the reactivity inside one cycle.
    // Same precedent as `outbound_commitment_overdue_count`.
    producer_kind: 'housekeeping',
    value_schema: ProjectNextActionGapSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    compression_class: 'derived',
    name: 'Project next-action gap',
    description: 'Flags active projects with no open task, pending commitment, or recent note. Directly feeds the engine\'s "what should I do next?" reasoning.',
    user_value: 'Surface projects that need a next-action defined before they stall.',
    tags: ['department:work'],
  },
  task_duplicate_candidate: {
    shape: 'per_record',
    valid_scopes: ['task'],
    policy: 'aggregate',
    aggregates_from: ['task'],
    recompute_cadence: '24h',
    producer_kind: 'housekeeping',
    value_schema: TaskDuplicateCandidateSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    compression_class: 'derived',
    name: 'Task duplicate candidate',
    description: 'Likely duplicates of a task across Sources (HubSpot + Salesforce + Recued tasks describing the same work). Emits `duplicate_candidate_set` + `dedupe_confidence: exact / probable / low`.',
    user_value: 'Catch duplicate tasks across Sources before they pile up — engine consumes for All Sources merging.',
    tags: ['department:work'],
  },
  source_freshness_degradation: {
    shape: 'derived_entity',
    policy: 'independent',
    // Spec § A.7.2 frames this as "housekeeping (hourly) + reactive (on
    // connection state change)". The reactive harness lift is a
    // deferred follow-on; today's enrichment harness only registers
    // `'housekeeping'` producers (`buildEnrichmentProducerTask` rejects
    // `'reactive'`). Cascade staling on the declaration's
    // `invalidation_triggers` (source_registry updates + connection
    // state changes) carries the bulk of the reactivity inside one
    // cycle. Same precedent as `outbound_commitment_overdue_count` +
    // `project_next_action_gap` (both reactive in spec, housekeeping in
    // registry pending the harness lift).
    //
    // Spec § A.7.3 documents `aggregates_from = ['source_registry',
    // 'connection']` on the producer; the registry-side
    // `aggregates_from` is typed against the closed warehouse-scope
    // enum (`EnrichmentScope | 'audit' | 'data_enrichment'`) and
    // doesn't carry operational tables. The declaration-side
    // `operates_on: ['source_registry', 'connection']` (open string
    // list) in `enrichment-declarations/source-freshness-degradation.ts`
    // carries the spec contract; cascade-side reactivity flows through
    // the declaration's `invalidation_triggers` instead.
    //
    // No `recompute_cadence` declared. Standalone tasks self-manage
    // cadence through the housekeeping scheduler (the per-task
    // `meta.interruptible` + scheduler-side eligibility gates). The
    // closest enum option `'6h'` would not match the spec's "hourly"
    // target. Same precedent as `organization` + `confidence_drift_-
    // signal` (independent-policy derived-entity standalone tasks that
    // omit recompute_cadence).
    producer_kind: 'housekeeping',
    value_schema: SourceFreshnessDegradationSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    compression_class: 'derived',
    name: 'Source freshness degradation',
    description: 'Per-Source health signal — sync staleness / disabled connection / partial coverage / failed reconciliation. Engine uses for omission decisions: when source A has stale data, omit source A from the AI packet OR include with `coverage.sources_degraded` flag.',
    user_value: 'See which Sources are degraded before recipes fail on them.',
    tags: ['department:work'],
  },
  context_packet_quality: {
    shape: 'derived_entity',
    policy: 'aggregate',
    aggregates_from: ['audit'],
    recompute_cadence: '24h',
    producer_kind: 'reactive',
    value_schema: PsiEligibleScoreSchema,
    sidecar: 'none',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
    emits_confidence: true,
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    compression_class: 'derived',
    name: 'Context packet quality',
    description: 'Quality self-assessment of a RecuedPlan run (context included / omitted / user corrections). Did included context satisfy the request, did omitted context look right, did the user undo or correct — feeds the C.3 benchmark + future engine tuning. PSI-eligible — D-133 catches when engine quality regresses across model upgrades.',
    user_value: 'Detect engine quality regressions before users notice them.',
    tags: ['department:work'],
  },

  // ── Shape B — derived entities (housekeeping — D-123 mode; producers ship post-D-123) ──────────
  topic_cluster: {
    return_shape:
      '{ topic_name: string, summary: string, members: [REF<mail>], thread_ids: [REF<mail>], theme_tokens: [string], thread_count: number, ai_invoked: boolean, computed_at: number, window_ms: number }',
    shape: 'derived_entity', policy: 'members_list',
    members_field: 'members', members_scope: 'mail',
    producer_kind: 'housekeeping',
    value_schema: TopicClusterSchema,
    sidecar: 'none',
    default_trust_state: 'manual',
    default_pool_policy: 'free_only',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'perspective',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    aggregate_window_ms: 90 * 24 * 60 * 60 * 1000, // 90d — matches producer's MAIL_LOOKBACK_MS
    identity_extractor: extractMailThreadIdentity,
    inputFingerprintComposition: 'perspective_fan_in',
    compression_class: 'lossy',
    prompt_bias_hints: ['favours_dominant_thread_signals_over_outliers', 'cluster_label_is_a_compressed_summary'],
    name: 'Topic cluster',
    description: 'Heuristically clustered mail messages sharing a topic, AI-labelled.',
    user_value: 'Browse mail by topic instead of folder; AI invents the labels from your data.',
  },
  working_group: {
    return_shape:
      '{ contacts: [REF<contacts>], contacts_resolved: [{ entity: REF<contacts>, name: string }], members: [REF<calendar>], event_count: number, last_event_at: number, first_event_at: number, computed_at: number }',
    shape: 'derived_entity', policy: 'members_list',
    members_field: 'members', members_scope: 'calendar',
    producer_kind: 'housekeeping',
    value_schema: WorkingGroupSchema,
    sidecar: 'none',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'perspective',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    identity_extractor: extractCalendarAttendees,
    inputFingerprintComposition: 'perspective_fan_in',
    compression_class: 'lossless',
    name: 'Working group',
    description: 'Group of contacts whose calendar attendance clusters together.',
    user_value: 'Spot ad-hoc teams forming around recurring meetings.',
  },
  organization: {
    return_shape:
      '{ domain: string, organization_name: string | null, contacts: [REF<contacts>], contacts_resolved: [{ entity: REF<contacts>, name: string }], contact_count: number, last_interaction_at: number, first_seen_at: number, computed_at: number }',
    shape: 'derived_entity', policy: 'independent',
    producer_kind: 'housekeeping',
    value_schema: OrganizationSchema,
    sidecar: 'none',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'perspective',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    identity_extractor: extractContactDomain,
    inputFingerprintComposition: 'perspective_fan_in',
    compression_class: 'derived',
    name: 'Organization',
    description: 'Inferred organisation from domain clustering of contacts.',
    user_value: 'See which orgs you interact with most without manual tagging.',
  },
  semantic_cluster: {
    shape: 'derived_entity', policy: 'members_list',
    members_field: 'members', members_scope: 'mail',
    producer_kind: 'housekeeping',
    value_schema: SemanticClusterSchema,
    sidecar: 'vector_index',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'perspective',
    lifecycle_policy: 'forward_only',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'event_time',
    identity_extractor: extractMailThreadIdentity,
    inputFingerprintComposition: 'perspective_fan_in',
    compression_class: 'derived',
    name: 'Semantic cluster',
    description: 'Mail clustered by embedding similarity.',
    user_value: 'Discover semantically-related mail across folders / labels.',
  },

  // ── Shape B — derived (D-133 — drift detection) ─────────────────
  // Per-source-topic Population Stability Index on AI-surface
  // producers' confidence distributions. Daily housekeeping cadence;
  // pure SQL aggregation over `data_enrichment` rows — zero token
  // cost. State-transition `enrichment_drift_detected` realtime event
  // fires once per `'none'` → `'moderate'` or `'moderate'` →
  // `'significant'` crossing. Default `trust_state: 'auto'`
  // (deterministic + zero-cost; honours D-132 trust gate).
  // Spec: D-133.
  confidence_drift_signal: {
    return_shape:
      '{ source_topic: string, psi: number, severity: string, baseline_window: { start_at: number, end_at: number, sample_count: number }, recent_window: { start_at: number, end_at: number, sample_count: number }, baseline_distribution: [number], recent_distribution: [number], computed_at: number }',
    shape: 'derived_entity',
    policy: 'independent',
    aggregates_from: ['data_enrichment'],
    producer_kind: 'housekeeping',
    value_schema: ConfidenceDriftSignalSchema,
    sidecar: 'none',
    temporal_class: 'aggregate_window',
    identity_aggregation: 'perspective',
    // D-136 P4 — `'historical'` (was `'recompute_on_drift'` at D-133) so
    // the trajectory of PSI severity per source topic is preserved
    // across cycles via the supersede chain instead of overwritten in
    // place. The drift producer itself does not regen on its own drift
    // — `recompute_on_drift` here would have been a self-loop. P5 lands
    // the writer-side append-with-supersede mechanics; the registry
    // declaration ships at P4 so the §A.8 validator and P7 consumers
    // observe the correct policy.
    lifecycle_policy: 'historical',
    as_of_field: 'computed_at',
    aggregate_window_axis: 'ingestion_time',
    identity_extractor: extractDriftSignalSourceTopic,
    inputFingerprintComposition: 'upstream_chain',
    compression_class: 'derived',
    name: 'Confidence drift signal',
    description: 'Silent-regression detector for AI-derived facts. Population Stability Index on producer confidence distributions.',
    user_value: 'See when an AI producer is getting worse before downstream symptoms appear.',
    default_trust_state: 'auto',
    default_pool_policy: 'free_only',
  },
} as const satisfies Record<string, EnrichmentDefinition>;

/** Closed string-literal union over all reserved topic IDs. */
export type EnrichmentTopic = keyof typeof ENRICHMENT_REGISTRY;

/** Cheap predicate — narrows an arbitrary string to a registered topic.
 *  Validators / resolvers / kernel ingredients gate every external
 *  topic reference through this. */
export const isEnrichmentTopic = (s: string): s is EnrichmentTopic =>
  Object.prototype.hasOwnProperty.call(ENRICHMENT_REGISTRY, s);

/** Lookup that throws when the topic isn't registered. Server-side
 *  callers know the topic exists (validator already gated); recipe-side
 *  callers should `isEnrichmentTopic` first. */
export const getEnrichmentDefinition = (topic: string): EnrichmentDefinition => {
  if (!isEnrichmentTopic(topic)) {
    throw new Error(`enrichment_topic_unknown: ${topic}`);
  }
  return ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
};

/** Returns the closed list of topics a given scope can carry. Used by
 *  the validator to surface a helpful "valid topics on `mail` are …"
 *  message, and by the cascade engine to narrow its dispatch. */
export const enrichmentTopicsForScope = (
  scope: EnrichmentScope,
): EnrichmentTopic[] => {
  const out: EnrichmentTopic[] = [];
  for (const topic of Object.keys(ENRICHMENT_REGISTRY) as EnrichmentTopic[]) {
    const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
    if (def.shape === 'per_record' && def.valid_scopes?.includes(scope)) out.push(topic);
  }
  return out;
};

/** D-133 — closed list of topics whose persisted `value` carries a
 *  `confidence: number` field. The drift producer iterates this set
 *  to compute rolling PSI per source topic. */
export const confidenceEmittingEnrichmentTopics = (): EnrichmentTopic[] => {
  const out: EnrichmentTopic[] = [];
  for (const topic of Object.keys(ENRICHMENT_REGISTRY) as EnrichmentTopic[]) {
    const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
    if (def.emits_confidence) out.push(topic);
  }
  return out;
};

/** D-132 — resolve the effective default trust state for a topic.
 *  When the registry declares `default_trust_state`, that wins; the
 *  validator at producer-registration time guarantees the declaration
 *  is consistent with producer `ai_surface`. Otherwise falls back to
 *  the AI-vs-deterministic heuristic — `'manual'` for AI-surface
 *  producers, `'auto'` for deterministic ones. Reactive producers
 *  always default to `'auto'` regardless of `ai_surface` because
 *  their fire is event-driven, not idle-driven; the `'manual'` state
 *  on a reactive producer means "block until enrolled" (post-launch
 *  semantics — pre-launch reactive producers are deterministic). */
export const resolveEnrichmentTrustDefault = (
  topic: EnrichmentTopic,
  isAiSurface: boolean,
): 'off' | 'manual' | 'auto' => {
  const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
  if (def.default_trust_state) return def.default_trust_state;
  if (def.producer_kind === 'reactive') return 'auto';
  return isAiSurface ? 'manual' : 'auto';
};

/** D-132 — resolve the effective default pool policy for a topic.
 *  Falls back to `'free_then_byok'` (the conservative default —
 *  see `POOL_POLICY_DEFAULT` in `enrichment-trust.ts`) when the
 *  registry declares no override. */
export const resolveEnrichmentPoolPolicyDefault = (
  topic: EnrichmentTopic,
): 'free_only' | 'free_then_byok' | 'byok_only' => {
  const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
  return def.default_pool_policy ?? 'free_then_byok';
};

/** D-136 §A.13.5 — resolve the effective MCP-exposure policy for a
 *  topic. Reads the registry annotation; defaults to `'public'` when
 *  the topic omits the field. MCP read handlers (`registry.describe`
 *  filter, `enrichment.read` reject, `vector.similarity_search`
 *  reject) gate on `'private'`. Throws when the topic isn't
 *  registered — callers gate via `isEnrichmentTopic` first. */
export const resolveMCPExposure = (topic: EnrichmentTopic): MCPExposurePolicy => {
  const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
  return def.mcp_exposed ?? 'public';
};

/** D-136 §A.13.5 — convenience predicate. True when the topic is
 *  declared `mcp_exposed: 'private'`. Returns false for topics with
 *  the default `'public'` exposure (or omitted annotation). MCP
 *  handlers prefer this over an inline lookup at every call site. */
export const isMCPPrivateTopic = (topic: EnrichmentTopic): boolean =>
  resolveMCPExposure(topic) === 'private';

/** D-132 — validator gate at producer-registration time. Throws when
 *  a registry-declared default is inconsistent with the producer's
 *  `ai_surface`. Specifically:
 *    - `default_trust_state: 'auto'` on a `producer_kind: 'housekeeping'`
 *      topic is incompatible with an AI-surface producer (no surprise
 *      background AI per the spec's load-bearing decision §4).
 *  Called from `enrichment-producer.ts:buildEnrichmentProducerTask`.
 *  Pure function; no side effects. */
export const assertEnrichmentTrustDefaults = (
  topic: EnrichmentTopic,
  isAiSurface: boolean,
): void => {
  const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
  if (
    def.producer_kind === 'housekeeping' &&
    def.default_trust_state === 'auto' &&
    isAiSurface
  ) {
    throw new Error(
      `enrichment_trust_default_inconsistent: topic '${topic}' declares ` +
        `default_trust_state: 'auto' but its producer is AI-surface ` +
        `(estimate_per_record_tokens > 0). AI producers must default to ` +
        `'manual' or 'off'.`,
    );
  }
};

// ────────────────────────────────────────────────────────────────
// D-136 §A.8 — Lifecycle / temporal-class / identity-aggregation gates
// ────────────────────────────────────────────────────────────────

/** Time-travelable source list (audit §5). Other sources are
 *  non-travelable, so `recompute_on_drift` is rejected for
 *  `aggregate_window` topics whose `aggregates_from` includes any
 *  non-travelable scope. `'audit'` (the run-provenance trail) and
 *  `'data_enrichment'` (per-topic enrichment rows) are append-only by
 *  construction — which is exactly why the owner's `user_memory` pool could
 *  never have belonged here: it has update + delete. */
const TIME_TRAVELABLE_AGGREGATES_FROM: ReadonlySet<string> = new Set([
  'audit',
  'data_enrichment',
]);

const sourcesAreTimeTravelable = (
  aggregates_from: ReadonlyArray<EnrichmentScope | 'audit' | 'data_enrichment'> | undefined,
): boolean => {
  if (!aggregates_from || aggregates_from.length === 0) return false;
  return aggregates_from.every((s) => TIME_TRAVELABLE_AGGREGATES_FROM.has(s));
};

/** D-136 §A.8 — pure validator over an `EnrichmentDefinition`. Returns
 *  the array of issue strings (empty when the definition passes every
 *  gate). Exposed for direct unit testing without registry mutation;
 *  the topic-keyed wrapper `assertEnrichmentLifecycleDefaults` calls
 *  this and throws on the first issue.
 *
 *  Eleven gates (the eight original §A.8 gates, two §A.14 advisory-
 *  annotation gates added at P3 follow-up, and one §A.13.5 MCP-exposure
 *  closed-list gate added at P7.E):
 *    1. `emits_confidence: true` requires `temporal_class === 'stable_truth'`.
 *    2. Non-stable_truth topics MUST declare `as_of_field`.
 *    3. `time_bound + recompute_on_drift` is forbidden (corrupts history).
 *    4. `aggregate_window + recompute_on_drift` requires fully-time-travelable
 *       `aggregates_from` (audit §5: only `audit` qualifies today).
 *    5. `lifecycle_policy: 'ttl'` requires `ttl_days`.
 *    6. `perspective` topics MUST declare `identity_extractor`.
 *    7. `aggregate_window` topics MUST declare `aggregate_window_axis`.
 *    8. `aggregate_window` OR `perspective` topics MUST declare
 *       `inputFingerprintComposition` (per-record producers may omit;
 *       degenerates to `source_record_hash`).
 *    9. `compression_class` is required and must be one of
 *       `'lossless' | 'lossy' | 'derived'` (§A.14.2).
 *   10. `prompt_bias_hints` (when present) is a non-empty array whose
 *       entries match `PROMPT_BIAS_HINT_RE` — lowercase ASCII words
 *       separated by underscores (§A.14.3 shape-only gate).
 *   11. `mcp_exposed` (when present) must be one of
 *       `'public' | 'private'` (§A.13.5 closed-list gate). The field is
 *       optional; omit for the `'public'` default. */
export const validateLifecycleDefinition = (
  topic: string,
  def: EnrichmentDefinition,
): string[] => {
  const issues: string[] = [];

  // Gate 1 — emits_confidence requires stable_truth
  if (def.emits_confidence && def.temporal_class !== 'stable_truth') {
    issues.push(
      `enrichment_lifecycle_invariant: topic '${topic}' has emits_confidence: true but ` +
        `temporal_class: '${def.temporal_class}' — PSI is only meaningful on stable_truth ` +
        `topics (time_bound + aggregate_window topics conflate model drift with real-world ` +
        `entity drift).`,
    );
  }

  // Gate 2 — non-stable_truth requires as_of_field
  if (def.temporal_class !== 'stable_truth' && !def.as_of_field) {
    issues.push(
      `enrichment_lifecycle_invariant: topic '${topic}' has temporal_class: '${def.temporal_class}' ` +
        `but no as_of_field declared. Time-bound + aggregate_window topics must stamp as_of explicitly.`,
    );
  }

  // Gate 3 — time_bound + recompute_on_drift forbidden
  if (
    def.temporal_class === 'time_bound' &&
    def.lifecycle_policy === 'recompute_on_drift'
  ) {
    issues.push(
      `enrichment_lifecycle_invariant: topic '${topic}' is time_bound; recompute_on_drift is ` +
        `forbidden (would corrupt historical record by overwriting against current data).`,
    );
  }

  // Gate 4 — aggregate_window + recompute_on_drift requires time-travelable sources
  if (
    def.temporal_class === 'aggregate_window' &&
    def.lifecycle_policy === 'recompute_on_drift' &&
    !sourcesAreTimeTravelable(def.aggregates_from)
  ) {
    issues.push(
      `enrichment_lifecycle_invariant: topic '${topic}' has lifecycle_policy: 'recompute_on_drift' ` +
        `but aggregates from non-time-travelable sources ` +
        `(${(def.aggregates_from ?? []).join(', ')}). Replay against original snapshot impossible — ` +
        `only 'audit' is time-travelable today (audit §5).`,
    );
  }

  // Gate 5 — ttl requires ttl_days
  if (def.lifecycle_policy === 'ttl' && def.ttl_days === undefined) {
    issues.push(
      `enrichment_lifecycle_invariant: topic '${topic}' has lifecycle_policy: 'ttl' but no ttl_days declared.`,
    );
  }

  // Gate 6 — perspective requires identity_extractor
  if (def.identity_aggregation === 'perspective' && !def.identity_extractor) {
    issues.push(
      `enrichment_lifecycle_invariant: topic '${topic}' has identity_aggregation: 'perspective' but ` +
        `no identity_extractor declared. Cascade-from-identity-change cannot fan in correctly.`,
    );
  }

  // Gate 7 — aggregate_window requires aggregate_window_axis
  if (def.temporal_class === 'aggregate_window' && !def.aggregate_window_axis) {
    issues.push(
      `enrichment_lifecycle_invariant: topic '${topic}' is aggregate_window but no ` +
        `aggregate_window_axis declared. Must specify event_time | ingestion_time so first-install ` +
        `backfill behavior is unambiguous.`,
    );
  }

  // Gate 8 — aggregate_window OR perspective requires inputFingerprintComposition
  if (
    (def.temporal_class === 'aggregate_window' ||
      def.identity_aggregation === 'perspective') &&
    !def.inputFingerprintComposition
  ) {
    issues.push(
      `enrichment_lifecycle_invariant: topic '${topic}' is ${def.temporal_class}/${def.identity_aggregation} ` +
        `but no inputFingerprintComposition declared. Aggregate / perspective topics MUST fold their ` +
        `full input set into input_fingerprint_hash; per-record source_record_hash alone is insufficient.`,
    );
  }

  // Gate 9 — compression_class required + closed-list (D-136 §A.14.2)
  if (!ALL_COMPRESSION_CLASSES.includes(def.compression_class)) {
    issues.push(
      `enrichment_lifecycle_invariant: topic '${topic}' has compression_class: ${JSON.stringify(def.compression_class)} ` +
        `but must be one of: ${ALL_COMPRESSION_CLASSES.join(', ')} (§A.14.2 — required at registration).`,
    );
  }

  // Gate 10 — prompt_bias_hints shape (D-136 §A.14.3)
  if (def.prompt_bias_hints !== undefined) {
    if (!Array.isArray(def.prompt_bias_hints)) {
      issues.push(
        `enrichment_lifecycle_invariant: topic '${topic}' has prompt_bias_hints declared but it is not an array.`,
      );
    } else if (def.prompt_bias_hints.length === 0) {
      issues.push(
        `enrichment_lifecycle_invariant: topic '${topic}' has empty prompt_bias_hints array — omit the field instead.`,
      );
    } else {
      for (const hint of def.prompt_bias_hints) {
        if (typeof hint !== 'string' || !PROMPT_BIAS_HINT_RE.test(hint)) {
          issues.push(
            `enrichment_lifecycle_invariant: topic '${topic}' has prompt_bias_hints entry ${JSON.stringify(hint)} ` +
              `that does not match PROMPT_BIAS_HINT_RE (lowercase ASCII words separated by underscores).`,
          );
        }
      }
    }
  }

  // Gate 11 — mcp_exposed closed-list (D-136 §A.13.5). Optional; when
  // set, must be 'public' or 'private'. Default at the resolver layer
  // is 'public' — omit the field to inherit it.
  if (
    def.mcp_exposed !== undefined
    && !ALL_MCP_EXPOSURE_POLICIES.includes(def.mcp_exposed)
  ) {
    issues.push(
      `enrichment_lifecycle_invariant: topic '${topic}' has mcp_exposed: ${JSON.stringify(def.mcp_exposed)} ` +
        `but must be one of: ${ALL_MCP_EXPOSURE_POLICIES.join(', ')} (§A.13.5 — closed list when present).`,
    );
  }

  return issues;
};

/** D-136 §A.8 — registry-level gate. Called from
 *  `enrichment-producer.ts:buildEnrichmentProducerTask` alongside
 *  `assertEnrichmentTrustDefaults` so registration mistakes surface
 *  before any cycle runs. Throws on the first issue. */
export const assertEnrichmentLifecycleDefaults = (
  topic: EnrichmentTopic,
): void => {
  const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
  const issues = validateLifecycleDefinition(topic, def);
  if (issues.length > 0) {
    throw new Error(issues[0]!);
  }
};

// ────────────────────────────────────────────────────────────────
// D-136 §A.3 — Producer-version hash composition
// ────────────────────────────────────────────────────────────────

/** Inputs to `computeProducerVersionHash`. Per-producer (not per-topic)
 *  — the same producer typically writes one topic, but composition is
 *  defined at the producer level so a producer's `producer_version_hash`
 *  bumps once per code/model/prompt/adapter/ingredient change rather
 *  than once per topic.
 *
 *  Closed-list inputs:
 *    - `producer_code_hash` — FNV-1a of the producer's source-code
 *      module text (or a build-time stamp). Bumps on producer-code
 *      change.
 *    - `model_id` — resolved provider model id (`'gpt-4o-mini'`,
 *      `'claude-haiku-4-5'`, …). NOT the ingredient slug — the slug is
 *      stamped per-row in `ingredient_slug`. Empty string when the
 *      producer is deterministic (no AI call).
 *    - `prompt_template_hash` — FNV-1a of the producer's prompt
 *      template text. Empty string when deterministic.
 *    - `adapter_version` — version string of the LLM-adapter layer
 *      (today the `@recued/llm` driver version). Empty string when
 *      deterministic.
 *    - `consumed_ingredients_versions` — for upstream-consuming
 *      producers, sorted list of `{ slug, version }` pairs covering
 *      every kernel ingredient invoked. Empty array for producers
 *      that don't compose ingredients.
 *
 *  Stability invariants (locked by P2 tests):
 *    - Same input → same hash, byte-stable across processes (no
 *      `Date.now`, no random). FNV-1a is deterministic by construction.
 *    - Order of `consumed_ingredients_versions` does NOT matter — the
 *      composer sorts before hashing.
 *    - Any single field change flips the hash. */
export interface ProducerVersionHashInput {
  producer_code_hash: string;
  model_id: string;
  prompt_template_hash: string;
  adapter_version: string;
  consumed_ingredients_versions: ReadonlyArray<{ slug: string; version: string }>;
  /** Spec § A.7.8 (Amended 2026-05-26) — OPTIONAL FNV-1a hex over the
   *  user's effective per-topic tunable param values, canonically
   *  serialized (sorted-key `key=value` pairs joined by `\x1f`). When
   *  the user tunes a param, this slot flips, the composed hash
   *  changes, the existing D-136 P5b cascade stales `data_enrichment`
   *  rows for the topic, and the next housekeeping cycle re-derives
   *  with the new value. Topics without `tunable_params` declared
   *  pass an empty string (or omit the field) — the composer treats
   *  undefined + empty identically for backward-compat. */
  tunable_params_hash?: string;
}

/** D-136 §A.3 — compose a `producer_version_hash` from the closed-list
 *  inputs above. Returns the canonical `'fnv1a:<8-char-hex>'` form,
 *  same self-describing prefix used by `EnrichmentMeta.snapshot_hash`
 *  (audit §27). The hex is lowercase, padded to 8 chars.
 *
 *  Composition: sort `consumed_ingredients_versions` by `slug`, join
 *  every input field with the unit-separator `\x1f`, FNV-1a the result.
 *  Unit separator is the same convention HubSpot/Salesforce reconcilers
 *  use (`backend/server/src/data/hubspot/_fnv1a.ts`); keeping the
 *  convention consistent makes future debug-tooling shareable.
 *
 *  Pure function. Used at producer registration today (so the registry
 *  validator can compute a per-producer baseline) and at producer call
 *  time at P3 (so each row's `producer_version_hash` matches the
 *  producer's current code+model+prompt+adapter+ingredients fingerprint).
 *
 *  Spec § A.7.8 (Amended 2026-05-26): the optional `tunable_params_hash`
 *  slot folds in last so backward-compat with pre-amendment producers
 *  is byte-stable (absent / empty string → identical composition + hash
 *  to the pre-amendment input shape). */
export const computeProducerVersionHash = (
  input: ProducerVersionHashInput,
): string => {
  const ingredients = [...input.consumed_ingredients_versions]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((e) => `${e.slug}:${e.version}`)
    .join(',');
  const baseFields = [
    input.producer_code_hash,
    input.model_id,
    input.prompt_template_hash,
    input.adapter_version,
    ingredients,
  ];
  // Backward-compat: an absent OR empty `tunable_params_hash` collapses
  // to the pre-amendment 5-field composition byte-for-byte. A
  // non-empty value extends the composition with a 6th field — flips
  // the hash exactly when the user tunes any param for the topic.
  const composedFields =
    typeof input.tunable_params_hash === 'string' && input.tunable_params_hash.length > 0
      ? [...baseFields, input.tunable_params_hash]
      : baseFields;
  const composed = composedFields.join('\x1f');
  return `fnv1a:${fnv1a32Hex(composed)}`;
};

/** FNV-1a 32-bit, returns lowercase hex padded to 8 chars. Mirrors the
 *  `backend/server/src/data/hubspot/_fnv1a.ts` and
 *  `packages/recipes/src/canonical.ts` implementations — kept private
 *  here to avoid a contracts→backend dependency. Post-launch, dedupe
 *  by lifting one canonical impl into a shared utility module.
 *
 *  Reference: http://isthe.com/chongo/tech/comp/fnv/#FNV-1a
 *  Offset basis: 0x811c9dc5, prime: 0x01000193. */
const fnv1a32Hex = (str: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/** D-136 §A.3 — composition inputs for `computeInputFingerprintHash`.
 *  The four-kind discriminator carries different fields:
 *
 *  - `per_record_source_hash`: degenerate to a single source row. The
 *    hash IS `source_record_hash`; producers don't compose anything.
 *    Carries `source_record_hash` only.
 *  - `aggregate_window_fold`: walks N source rows over a sliding
 *    window. Composition folds sorted source_record_hashes + window_ms
 *    + as_of + effective topic config (sorted JSON of any pack-/user-
 *    overridden topic-level field that materially changes "what this
 *    answer is"). Pack-window-override is the load-bearing case —
 *    `aggregate_window_ms: 30d → 2y` MUST flip the hash so dedup misses.
 *  - `perspective_fan_in`: aggregates upstream enrichment rows keyed on
 *    a canonical identity. Composition folds sorted
 *    `(enrichment_row_id, producer_version_hash)` pairs — the
 *    hash-of-hash chain so an upstream producer-version bump
 *    propagates downstream automatically.
 *  - `upstream_chain`: single upstream chain (`confidence_drift_signal`
 *    over its `data_enrichment` aggregate source). Same shape as
 *    `perspective_fan_in` but tracks a single contributor. */
export type InputFingerprintHashInput =
  | {
      kind: 'per_record_source_hash';
      source_record_hash: string;
    }
  | {
      kind: 'aggregate_window_fold';
      source_record_hashes: ReadonlyArray<string>;
      window_ms: number;
      as_of: number;
      /** Sorted-key serialisation of any topic-level config that
       *  materially changes the answer (today: pack-/user-overridden
       *  `aggregate_window_ms`, `ttl_days`, etc.). Pass `''` when no
       *  overrides apply. The composer hashes the string verbatim —
       *  caller is responsible for canonical sorting. */
      effective_topic_config: string;
    }
  | {
      kind: 'perspective_fan_in';
      /** Sorted ascending. Each pair: upstream's `_id` + the upstream
       *  producer's current `producer_version_hash`. Order does NOT
       *  matter — the composer sorts before hashing. */
      upstream: ReadonlyArray<{ enrichment_row_id: string; producer_version_hash: string }>;
      as_of: number;
      effective_topic_config: string;
    }
  | {
      kind: 'upstream_chain';
      /** Single upstream contributor. */
      upstream: { enrichment_row_id: string; producer_version_hash: string };
      as_of: number;
      effective_topic_config: string;
    };

/** D-136 §A.3 — compose `input_fingerprint_hash` from the four-kind
 *  discriminator. Per-record producers degenerate to
 *  `source_record_hash` (returns it verbatim — no double-hashing).
 *  Aggregate / perspective / upstream-chain variants fold all
 *  contributing inputs into one canonical string and FNV-1a it.
 *
 *  Stability invariants (locked by P3 tests):
 *    - Same inputs → same hash, byte-stable across processes.
 *    - Sort-invariant on `source_record_hashes` and `upstream`.
 *    - Any single field change flips the hash.
 *    - Per-record degenerate case returns `source_record_hash`
 *      verbatim (no `'fnv1a:'` prefix added) so the existing
 *      hash-skip rule in the harness keeps working unchanged.
 *
 *  Composition uses the same `\x1f` unit-separator convention as
 *  `computeProducerVersionHash` for debug-tooling consistency. */
export const computeInputFingerprintHash = (
  input: InputFingerprintHashInput,
): string => {
  if (input.kind === 'per_record_source_hash') {
    return input.source_record_hash;
  }
  if (input.kind === 'aggregate_window_fold') {
    const sortedHashes = [...input.source_record_hashes].sort().join(',');
    const composed = [
      'aggregate_window_fold',
      sortedHashes,
      String(input.window_ms),
      String(input.as_of),
      input.effective_topic_config,
    ].join('\x1f');
    return `fnv1a:${fnv1a32Hex(composed)}`;
  }
  if (input.kind === 'perspective_fan_in') {
    const sortedUpstream = [...input.upstream]
      .sort((a, b) => a.enrichment_row_id.localeCompare(b.enrichment_row_id))
      .map((u) => `${u.enrichment_row_id}:${u.producer_version_hash}`)
      .join(',');
    const composed = [
      'perspective_fan_in',
      sortedUpstream,
      String(input.as_of),
      input.effective_topic_config,
    ].join('\x1f');
    return `fnv1a:${fnv1a32Hex(composed)}`;
  }
  // upstream_chain
  const composed = [
    'upstream_chain',
    `${input.upstream.enrichment_row_id}:${input.upstream.producer_version_hash}`,
    String(input.as_of),
    input.effective_topic_config,
  ].join('\x1f');
  return `fnv1a:${fnv1a32Hex(composed)}`;
};

/** All sidecar variants the runtime knows about. Storage layer iterates
 *  this list when wiring foreign-key cascades. */
export const ALL_ENRICHMENT_SIDECARS: ReadonlyArray<EnrichmentSidecar> = [
  'none',
  'vector_index',
  'fts',
] as const;

/** Closed list of policy presets — shared by storage / cascade /
 *  validator dispatch tables. */
export const ALL_ENRICHMENT_POLICIES: ReadonlyArray<EnrichmentPolicy> = [
  'dependent',
  'members_list',
  'aggregate',
  'independent',
] as const;

/** D-128 — closed-list narrowing of `EnrichmentScope`. Excludes the
 *  open template-literal four-segment `connection.api.<vendor>.<entity>`
 *  shape; callers that need an exhaustive `Record<…, T>` over the
 *  closed scopes use this alias instead of `EnrichmentScope`. */
export type EnrichmentClosedScope = Exclude<
  EnrichmentScope,
  `connection.api.${string}.${string}`
>;

/** Closed list of every three-segment-or-shorter enrichment scope.
 *  Resolver / handler / validators iterate this set when sanity-checking
 *  inbound scope strings against the closed family. Platform-reference
 *  scopes (D-128, four-segment `connection.api.<vendor>.<entity>`) are
 *  open by construction — recognised via prefix match against the
 *  vendor-entity registry, not via this list. */
export const ALL_ENRICHMENT_SCOPES: ReadonlyArray<EnrichmentClosedScope> = [
  'mail',
  'contact',
  'calendar',
  'file',
  // D-145 PA4 — work-entity scopes (PA9 producers consume). Derived.
  ...WORK_ENTITY_KINDS,
  'connection.api',
  'connection.mcp',
  'connection.notification',
] as const;

/** D-145 PA4 — closed list of work-entity scopes. Producers consume
 *  this set via `valid_scopes`; the cascade engine walks rows keyed
 *  on these scopes when work-entity dispatchers fire. */
export const WORK_ENTITY_ENRICHMENT_SCOPES: ReadonlyArray<EnrichmentClosedScope> =
  WORK_ENTITY_KINDS;

/** D-125 P6.1 — the connection-namespace subset of `EnrichmentScope`.
 *  Used by the resolver to detect compound `connection.<kind>` scopes
 *  during ref-walking and by handlers to gate connection-targeted
 *  enrichment writes against the right kind. */
export const CONNECTION_ENRICHMENT_SCOPES: ReadonlyArray<EnrichmentClosedScope> = [
  'connection.api',
  'connection.mcp',
  'connection.notification',
] as const;

/** D-128 — `connection.api.<vendor>.<entity>` shape regex. Vendor +
 *  entity each match `[a-z][a-z0-9_]*`. Used by `isEnrichmentScope`
 *  and `composeVendorEntityScope` so the prefix-match path stays
 *  consistent. */
const PLATFORM_REFERENCE_SCOPE_RE =
  /^connection\.api\.([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/;

/** Cheap predicate — narrows an arbitrary string to a registered
 *  scope. Used by the rpc handler's input validator + resolver. The
 *  closed-list family matches by membership; the open D-128 family
 *  matches by prefix + regex shape. Unknown vendor/entity combinations
 *  pass shape-validation here; the upstream vendor-entity registry
 *  (`CONNECTION_VENDOR_ENTITIES` — see `connection-vendors.ts`) gates
 *  whether the combination is recognised as a registered vendor. */
export const isEnrichmentScope = (s: string): s is EnrichmentScope => {
  if ((ALL_ENRICHMENT_SCOPES as ReadonlyArray<string>).includes(s)) return true;
  return PLATFORM_REFERENCE_SCOPE_RE.test(s);
};

/** D-128 — predicate for the four-segment platform-reference family.
 *  Used by the cascade engine + resolver to choose the platform-reference
 *  walk path vs the closed-scope walk. */
export const isPlatformReferenceScope = (
  s: string,
): s is `connection.api.${string}.${string}` =>
  PLATFORM_REFERENCE_SCOPE_RE.test(s);

/** D-125 P6.1 — compose an enrichment scope from `(namespace,
 *  collection)`. The convention:
 *    - `('data', 'mail')`            → `'mail'`             (bare)
 *    - `('connection', 'api')`       → `'connection.api'`    (dotted)
 *
 *  No SQL migration: the storage column already accepts opaque text
 *  and the unique indexes key on the literal value. The composer is
 *  the canonical entry point — every callsite that derives a scope
 *  from a namespace + collection pair routes through it so the
 *  convention stays single-sourced.
 *
 *  Throws if the composed value isn't in `ALL_ENRICHMENT_SCOPES` —
 *  callers shouldn't pass combinations that don't map to a scope.
 *  For four-segment platform-reference scopes (D-128) use
 *  `composeVendorEntityScope` instead. */
export const composeEnrichmentScope = (
  namespace: EnrichmentNamespace,
  collection: string,
): EnrichmentClosedScope => {
  const composed = namespace === 'data' ? collection : `${namespace}.${collection}`;
  if (!(ALL_ENRICHMENT_SCOPES as ReadonlyArray<string>).includes(composed)) {
    throw new Error(
      `enrichment_scope_unknown: composeEnrichmentScope('${namespace}', '${collection}') → '${composed}' not in ALL_ENRICHMENT_SCOPES`,
    );
  }
  return composed as EnrichmentClosedScope;
};

/** D-128 — compose a four-segment platform-reference scope
 *  `'connection.api.<vendor>.<entity>'` for records that live on
 *  platforms the user does not mirror locally. Used by vendor Ds
 *  (D-129 HubSpot, D-130 Salesforce) to derive the canonical scope
 *  string at registration time.
 *
 *  Both segments must match `/^[a-z][a-z0-9_]*$/` — lowercase ASCII
 *  with optional digits + underscore separators. Throws on malformed
 *  input. The returned string is shape-valid but does NOT imply
 *  registration in `CONNECTION_VENDOR_ENTITIES` — callers register
 *  separately. */
export const composeVendorEntityScope = (
  vendor: string,
  entity: string,
): `connection.api.${string}.${string}` => {
  if (!/^[a-z][a-z0-9_]*$/.test(vendor)) {
    throw new Error(
      `enrichment_scope_invalid: vendor must match /^[a-z][a-z0-9_]*$/: '${vendor}'`,
    );
  }
  if (!/^[a-z][a-z0-9_]*$/.test(entity)) {
    throw new Error(
      `enrichment_scope_invalid: entity must match /^[a-z][a-z0-9_]*$/: '${entity}'`,
    );
  }
  return `connection.api.${vendor}.${entity}`;
};

/** D-128 — parse a platform-reference scope into its `(vendor, entity)`
 *  parts. Returns null for any non-four-segment scope. Counterpart to
 *  `composeVendorEntityScope`; used by the reconciliation harness
 *  (D-128 P2) to key cursor + cadence by vendor + entity. */
export const parseVendorEntityScope = (
  scope: string,
): { vendor: string; entity: string } | null => {
  const m = PLATFORM_REFERENCE_SCOPE_RE.exec(scope);
  if (!m) return null;
  return { vendor: m[1]!, entity: m[2]! };
};

/** D-190 (per-connection scoping follow-up) — compose the platform-reference
 *  `target_id` for ONE record reconciled under ONE connection.
 *
 *  The platform-reference SCOPE is per-vendor (`connection.api.<vendor>.<entity>`,
 *  shared across every connection of that vendor — see `composeVendorEntityScope`);
 *  the per-CONNECTION discriminator lives in the `target_id` instead. Two
 *  connections of the SAME vendor (`acme-hubspot`, `personal-hubspot`) draw
 *  platform-native ids from disjoint portals/orgs that overlap heavily (HubSpot
 *  ids are portal-scoped sequential integers — both portals have deals 1..N), so
 *  keying the mirror / enrichment store on the bare native id collides them
 *  (last-writer-wins data loss) AND makes the generic reconciler's per-scope
 *  self-filter ping-pong (each connection re-yields the other's id every cycle).
 *  Qualifying the `target_id` by `connection_name` gives each connection a disjoint
 *  id namespace, de-colliding the mirror, the enrichment rows, the timeline/audit
 *  links, and the cascade — all of which key on `(scope, target_id)` — in one move,
 *  with no schema change.
 *
 *  Shape `<vendor>_<entity>_<connection_name>_<native_id>` (e.g.
 *  `hubspot_deal_acme-corp_47291`). `connection_name` is the immutable connection
 *  PK, charset `/^[a-z0-9][a-z0-9-]{0,47}$/` — dash-only, NO underscore and NO dot —
 *  so the segment is cleanly delimited (the first `_` after the `<vendor>_<entity>_`
 *  prefix ends it) and never breaks the cross-vendor resolver's `.`-boundary walk.
 *  The `<vendor>_<entity>_` prefix is preserved verbatim, so the cross-vendor
 *  (`data.crm.*`) + vendor-alias (`data.<vendor>.*`) resolvers keep dispatching by
 *  `startsWith('<vendor>_<entity>_')` with NO change. */
export const composePlatformRecordTargetId = (
  vendor: string,
  entity: string,
  connection_name: string,
  native_id: string,
): string => `${vendor}_${entity}_${connection_name}_${native_id}`;

/** D-192 source-data-removal — the `target_id` PREFIX every mirror /
 *  enrichment row of ONE connection shares: `<vendor>_<entity>_<connection>_`
 *  (i.e. `composePlatformRecordTargetId` with the `native_id` stripped). The
 *  connection-teardown purge + the connection-delete tombstone cascade match
 *  `target_id LIKE '<prefix>%'` to scope the delete/tombstone to a SINGLE
 *  connection's records within the vendor-SHARED
 *  `connection.api.<vendor>.<entity>` scope — the same per-connection cut the
 *  D-190 reconciler's own delete-diff uses. The trailing `_` is load-bearing:
 *  it bounds the connection segment so `acme_` never prefix-matches `acme2_`
 *  (connection names are dash-only, no `_`/`%`, per `CONNECTION_NAME_REGEX`).
 *  Callers must LIKE-escape it (`%` `_` `\`) before use — the underscores here
 *  are literal, not wildcards. */
export const composeConnectionTargetIdPrefix = (
  vendor: string,
  entity: string,
  connection_name: string,
): string => `${vendor}_${entity}_${connection_name}_`;

// ────────────────────────────────────────────────────────────────
// D-134 — tag substrate helpers
// ────────────────────────────────────────────────────────────────

/** Map a scope to its `domain:` tag value. Three connection.* scopes
 *  collapse to the single `domain:connection` tag — the chip-filter
 *  groups them together (per-kind segmentation lives on the
 *  `policy:` chip when the producer carries different policies per
 *  scope, which today's connection-trio doesn't). D-128's four-segment
 *  platform-reference scopes (`connection.api.<vendor>.<entity>`) also
 *  collapse to `connection` — the vendor specificity surfaces via the
 *  author-declared `platform:` tag, not the auto-derived `domain:`. */
const CLOSED_SCOPE_TO_DOMAIN: Record<EnrichmentClosedScope, string> = {
  mail: 'mail',
  contact: 'contact',
  calendar: 'calendar',
  file: 'file',
  // D-145 PA4 — work-entity scopes collapse to a single `work` domain
  // tag for chip-filter grouping. Per-kind specificity surfaces via
  // the producer's declared `kind:` tag.
  task: 'work',
  note: 'work',
  commitment: 'work',
  project: 'work',
  booking: 'work',
  'connection.api': 'connection',
  'connection.mcp': 'connection',
  'connection.notification': 'connection',
};

const domainForScope = (scope: EnrichmentScope): string => {
  if (isPlatformReferenceScope(scope)) return 'connection';
  return CLOSED_SCOPE_TO_DOMAIN[scope as EnrichmentClosedScope];
};

/** D-134 — auto-derive the redundant tags (`domain:` / `policy:` /
 *  `shape:` / `kind:`) from an `EnrichmentDefinition`. The registry
 *  field is the source of truth; the auto-derived tag follows
 *  mechanically so an author renaming `policy: 'aggregate'` → `policy:
 *  'independent'` can't leave a stale `policy:aggregate` tag behind.
 *
 *  Excludes `surface:` — that requires the producer instance's
 *  `is_ai_surface` flag, which the registry definition doesn't carry.
 *  `surface:` is added by `computeHousekeepingMetaTags` at task-instance
 *  build time. */
export const deriveStandardEnrichmentTags = (
  def: EnrichmentDefinition,
): ReadonlyArray<EnrichmentTag> => {
  const tags: EnrichmentTag[] = [];
  if (def.valid_scopes && def.valid_scopes.length > 0) {
    const domains = new Set<string>();
    for (const scope of def.valid_scopes) {
      domains.add(domainForScope(scope));
    }
    for (const d of [...domains].sort()) {
      tags.push(`domain:${d}` as EnrichmentTag);
    }
  }
  tags.push(`policy:${def.policy}` as EnrichmentTag);
  tags.push(`shape:${def.shape}` as EnrichmentTag);
  tags.push(`kind:${def.producer_kind}` as EnrichmentTag);
  return tags;
};

/** D-134 — merge author-declared `def.tags` with auto-derived tags,
 *  deduplicate, return in stable order (author-declared first, then
 *  auto-derived). Does NOT include `surface:` — that's stamped at
 *  task-instance build time. */
export const collectEnrichmentTags = (
  def: EnrichmentDefinition,
): ReadonlyArray<EnrichmentTag> => {
  const seen = new Set<EnrichmentTag>();
  const out: EnrichmentTag[] = [];
  const push = (t: EnrichmentTag): void => {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  for (const t of def.tags ?? []) push(t);
  for (const t of deriveStandardEnrichmentTags(def)) push(t);
  return out;
};

/** D-134 — registry-wide tag-shape validator. Returns one issue string
 *  per malformed tag, prefixed with the topic id so the diagnostic
 *  points to the registry entry. Empty array means OK. Run alongside
 *  `assertEnrichmentTrustDefaults` at startup so registry mistakes
 *  surface before the first scheduler tick. */
export const assertRegistryTagShapes = (): string[] => {
  const issues: string[] = [];
  for (const topic of Object.keys(ENRICHMENT_REGISTRY) as EnrichmentTopic[]) {
    const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
    for (const tag of def.tags ?? []) {
      const tagIssues = assertEnrichmentTagShape(tag);
      for (const issue of tagIssues) {
        issues.push(`topic '${topic}': ${issue}`);
      }
    }
  }
  return issues;
};

/** D-134 — compute the full tag set stamped onto a `HousekeepingTaskMeta`.
 *  The enrichment path passes `def` + the producer instance's
 *  `is_ai_surface` flag; the helper merges author-declared tags,
 *  auto-derives `domain:` / `policy:` / `shape:` / `kind:`, and
 *  stamps `surface:ai|deterministic` from `is_ai_surface`. The
 *  core-task path passes `def: undefined` and supplies the full tag
 *  set via `extraTags` (typically `['kind:core', 'domain:<x>',
 *  'surface:deterministic']`).
 *
 *  Output is deduplicated; insertion order:
 *    1. `extraTags` (caller-supplied)
 *    2. `def.tags` (author-declared on the registry entry)
 *    3. auto-derived from `def` via `deriveStandardEnrichmentTags`
 *    4. `surface:` from `is_ai_surface`
 *
 *  Stable across calls so registry-driven snapshot tests don't churn. */
export const computeHousekeepingMetaTags = (input: {
  def?: EnrichmentDefinition;
  isAiSurface?: boolean;
  extraTags?: ReadonlyArray<EnrichmentTag>;
}): ReadonlyArray<EnrichmentTag> => {
  const seen = new Set<EnrichmentTag>();
  const out: EnrichmentTag[] = [];
  const push = (t: EnrichmentTag): void => {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  for (const t of input.extraTags ?? []) push(t);
  if (input.def) {
    for (const t of input.def.tags ?? []) push(t);
    for (const t of deriveStandardEnrichmentTags(input.def)) push(t);
  }
  if (input.isAiSurface !== undefined) {
    push((input.isAiSurface ? 'surface:ai' : 'surface:deterministic') as EnrichmentTag);
  }
  return out;
};

/** Pre-resolved nested reference into a warehouse collection — the
 *  declarative `{entity, name}` shape used by producers that already
 *  have the display name at write time. The `name` is the human-readable
 *  surface; `entity` is the canonical key into the collection (typically
 *  the canonical email for contacts). LLMs use `name` directly; can still
 *  resolve via `entity.query` for additional fields.
 *
 *  Distinct from REF<X> in catalog-declaration shape strings — REF<X> is a
 *  type annotation on a primitive-string field; EntityRef is the
 *  value-level nested record convention for already-resolved refs. */
export interface EntityRef {
  readonly entity: string;
  readonly name: string;
}

/** Fallback route handed back when an enrichment producer has no data
 *  for the requested entity. Carries a deterministic next-step — the
 *  producer knows its own fallback path (working_group -> mail,
 *  organization -> domain grouping, etc.) so the LLM gets the next
 *  tool to try without a second round-trip.
 *
 *  Two surfaces use this shape:
 *    - Declaration-side default (D-164 P2 — `EnrichmentDeclaration.suggest_directive`):
 *      the registry-load-time fallback the catalog substrate (P3) renders
 *      into the system prompt for this topic.
 *    - Runtime emission (`EnrichmentResult<T>.suggest`): the per-call
 *      directive the producer hands back on NOT-FOUND; typically the
 *      declaration default specialized with per-target args. */
export interface SuggestDirective {
  /** Catalog tool name to call next, e.g. 'entity.query'. */
  readonly tool: string;
  /** Tool-specific kind/collection hint, e.g. 'mail' | 'calendar' | 'contact'. */
  readonly kind: string;
  /** Human-readable directive for the LLM. */
  readonly hint: string;
  /** Optional pre-shaped arguments for the suggested tool call. */
  readonly args?: Readonly<Record<string, unknown>>;
}

/** Producer return — natural-payload union with the not-found branch.
 *  T is the producer's natural shape (record or array of records). On
 *  found, the producer's record is merged with {found: true}. On
 *  not-found, the producer hands back a SuggestDirective routing the
 *  LLM to a deterministic fallback. */
export type EnrichmentResult<T extends object & { found?: never }> =
  | ({ readonly found: true } & T)
  | { readonly found: false; readonly suggest: SuggestDirective };
