/** D-122 Phase 4.5 — `data.enrichment.*` storage layer.
 *
 *  Single SQLite table backing the unified enrichment namespace. Two
 *  row shapes coexist via NULL-aware unique indexes:
 *
 *    - Shape A — per-record fact. `scope` ∈ `{mail, contact, calendar,
 *      file}`; `target_id` keys the source record. Idempotent on
 *      `(topic, scope, target_id, authored_by)` — the same recipe
 *      writing the same topic for the same record replaces in place.
 *
 *    - Shape B — derived entity. `scope` and `target_id` are NULL; the
 *      row's `_id` IS the derived entity's id (e.g. `topic_cluster_<hash>`).
 *      Idempotent on `(topic, _id)`.
 *
 *  Two sidecar tables hang off `data_enrichment._id` via FOREIGN KEY
 *  ... ON DELETE CASCADE — so deleting the main row also drops every
 *  sidecar entry. Vector-index sidecar stores raw embedding bytes for
 *  similarity search; FTS sidecar uses SQLite's contentless FTS5 over
 *  the `value` JSON. `staleness_class != 'fresh'` (cascade-mark on
 *  source update) drops the sidecar row immediately so search results
 *  don't reflect stale content.
 *
 *  Validation: every write looks up `topic` in
 *  `ENRICHMENT_REGISTRY` and runs the registry's `value_schema` over
 *  `value`. Unknown topics throw `EnrichmentTopicUnknownError`;
 *  validator failures throw `EnrichmentValueInvalidError` carrying the
 *  issue list.
 *
 *  Spec: `docs/d-122-spec.md` §"Enrichment substrate" — Storage. */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  CONNECTION_VENDOR_ENTITIES,
  ENRICHMENT_PINNED_AUTHOR_PREFIX,
  ENRICHMENT_REGISTRY,
  ENRICHMENT_VOTE_KINDS,
  ENRICHMENT_VOTE_SOURCES,
  getEnrichmentDefinition,
  isEnrichmentScopeSupported,
  isEnrichmentTopic,
  originProvenanceFromActor,
  serializeEnrichmentMeta,
  deserializeEnrichmentMeta,
  type Actor,
  type ConnectionVendorEntity,
  type EnrichmentDefinition,
  type EnrichmentMeta,
  type EnrichmentScope,
  type EnrichmentTopic,
  type EnrichmentUpsertMode,
  type EnrichmentVoteKind,
  type EnrichmentVoteSource,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

const ENRICHMENT_TABLE = 'data_enrichment';
const VECTOR_INDEX_TABLE = 'data_enrichment_vector_index';
const FTS_TABLE = 'data_enrichment_fts';
/** D-136 §A.6 + §A.11 — quality-vote receiver substrate. P2 ships
 *  schema only; the writer (`enrichment.vote` rpc) lands in P7. */
const QUALITY_VOTE_TABLE = 'data_enrichment_quality_vote';
/** D-136 §A.14.1 — external-context pulse table backing
 *  `consumes_external_context` producer-manifest entries. Cascade
 *  reads pulse changes and flips consuming rows to
 *  `lifecycle_action_pending = 'recompute'`. P2 ships schema only. */
const EXTERNAL_CONTEXT_PULSE_TABLE = 'external_context_pulse';

/** D-192 — escape LIKE metacharacters (`\` `%` `_`) so a `target_id` prefix
 *  match (`LIKE '<prefix>%' ESCAPE '\'`) treats the prefix's literal
 *  underscores as literals — `acme_` must not prefix-match `acme2_`. */
const escapeLikeWildcards = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

/** D-136 §A.6 — three-state staleness class. Replaces D-122's binary
 *  `stale: 0|1`. `'fresh'` is the post-write default; the cascade engine
 *  flips rows to `'stale'` on dependent-source change and `'expired'`
 *  on TTL / tombstone events. The legacy `stale` column is dropped at
 *  P2 (pre-launch zero-installs — see audit §20.2 + handover). */
export type EnrichmentStalenessClass = 'fresh' | 'stale' | 'expired';

/** D-136 §A.6 — closed-list lifecycle actions persisted on
 *  `lifecycle_action_pending`. The schema column itself is plain TEXT
 *  so P6 carries `'retry_at_<ts>'` tokens (runtime synthesis from the
 *  retry/backoff schedule) without widening the type union — callers
 *  read `parseRetryAtToken` to round-trip the embedded timestamp. */
export type LifecycleActionPending =
  | 'recompute'
  | 'discard'
  | 'permanently_failed';

/** D-136 §A.6 / audit §9 P6 — exponential backoff schedule for
 *  per-row producer-failure retries. Index N is the wait between the
 *  Nth failure and the (N+1)th attempt; element count caps total
 *  attempts. After `RETRY_BACKOFFS_MS.length` failures the row
 *  escalates to `'permanently_failed'` instead of receiving another
 *  retry slot. */
export const RETRY_BACKOFFS_MS: ReadonlyArray<number> = [
  2 * 60 * 1000,        //  2 minutes
  8 * 60 * 1000,        //  8 minutes
  30 * 60 * 1000,       // 30 minutes
  2 * 60 * 60 * 1000,   //  2 hours
];

/** D-136 §A.6 P6 — round-trip the `retry_at_<ts>` LAP token. Returns
 *  the embedded epoch-ms timestamp when the token matches the shape;
 *  `null` for any other value (including null, `'recompute'`,
 *  `'discard'`, `'permanently_failed'`, malformed tokens). The harness
 *  consults this to skip rows whose retry window hasn't opened yet. */
export const parseRetryAtToken = (token: string | null | undefined): number | null => {
  if (typeof token !== 'string') return null;
  const m = /^retry_at_(\d+)$/.exec(token);
  if (!m) return null;
  const ts = Number(m[1]);
  if (!Number.isFinite(ts)) return null;
  return ts;
};

/** D-136 §A.6 P6 — compose a `retry_at_<ts>` LAP token. Caller passes
 *  the ABSOLUTE epoch-ms wake time (current clock + chosen backoff). */
export const composeRetryAtToken = (wake_at_ms: number): string =>
  `retry_at_${wake_at_ms}`;

/** Meta to write on a chain-INSERT (supersede / first-write). The
 *  supersede analog of `meta = COALESCE(?, meta)` on the overwrite
 *  UPDATEs: an explicit `metaSerialized` (writer supplied meta) always
 *  wins; a meta-less write that supersedes a prior head carries that
 *  head's stored meta forward so the new chain head isn't meta-NULL
 *  until the next reconciler refresh; a first-write / overwrite-no-head
 *  insert (no prior head) keeps NULL. At the insert sites a defined
 *  `head` means supersede-with-prior-head by construction — an
 *  overwrite-with-head took the UPDATE branch and never reaches here. */
const inheritMetaOnSupersede = (
  metaSerialized: string | null,
  head: Record<string, unknown> | undefined,
): string | null =>
  metaSerialized ?? ((head?.meta as string | null | undefined) ?? null);

/** A persisted enrichment row as the store returns it. Shape A vs B is
 *  carried by `scope` / `target_id` nullability. D-128 adds `meta`
 *  (snapshot for platform-reference scopes) + `mirror_blob_hash`
 *  (forward-compat slot for full-record local mirror). D-136 P2 adds
 *  the bistemporal stamping columns + dedup hashes + lifecycle action /
 *  failure / supersede tracking, and renames legacy `model_used` →
 *  `ingredient_slug` (the column was mis-stamping the ingredient slug
 *  rather than the resolved model id — audit §20.2). */
export interface EnrichmentRecord {
  _id: string;
  topic: EnrichmentTopic;
  scope: EnrichmentScope | null;
  target_id: string | null;
  value: unknown;
  authored_by: string;
  source_record_hash: string | null;
  recipe_hash: string | null;
  /** D-136 P2 — renamed from legacy `model_used`. Records the
   *  ingredient slug (`'ai-classify'`, `'ai-extract'`, …) the producer
   *  invoked. Producer code populates this until P3 retrofits the wrapper. */
  ingredient_slug: string | null;
  /** D-136 P2 — resolved provider model id (`'gpt-4o-mini'`,
   *  `'claude-haiku-4-5'`, …). Populated by the ForceLayer resolver at
   *  producer call time once P3 lands; NULL until then. Cross-model PSI
   *  comparisons (Groq free pool ↔ Anthropic BYOK) require this. */
  model_id: string | null;
  event_at: number | null;
  ingested_at: number;
  authored_at: number;
  /** D-136 P2 — bistemporal stamping. `as_of` snapshots the producer's
   *  effective compute time; `last_evaluated_at` records the most-recent
   *  housekeeping pass that touched the row (refresh / dedup-hit). Both
   *  NULL on legacy rows + on rows written before producers retrofit at P3. */
  as_of: number | null;
  last_evaluated_at: number | null;
  /** D-136 §A.3 — producer-version + input-set hashes that form the
   *  dedup primary key `(target_id, input_fingerprint_hash,
   *  producer_version_hash)`. Per-record producers populate
   *  `input_fingerprint_hash = source_record_hash` in the degenerate
   *  case; aggregate / perspective producers compose at P3. NULL until
   *  P3 retrofits producers. */
  producer_version_hash: string | null;
  input_fingerprint_hash: string | null;
  /** D-136 §A.6 — `[0, 1]` fraction of expected sources contributed.
   *  NULL for scenario-shape rows; REQUIRED on perspective writes once
   *  the validator gate at `enrichment-upsert` lands (P5). */
  input_completeness: number | null;
  /** D-136 §A.6 — three-state replacement for legacy binary `stale`.
   *  Default `'fresh'` at insert; cascade engine flips to `'stale'` on
   *  source change and `'expired'` on TTL / tombstone. */
  staleness_class: EnrichmentStalenessClass;
  /** D-136 §A.6 — pending lifecycle action. `null` for steady-state
   *  rows; cascade / failure paths populate one of the recognised
   *  values (`'recompute'` / `'discard'` / `'permanently_failed'` / a
   *  `'retry_at_<ts>'` token). P5 wires the consumers. */
  lifecycle_action_pending: string | null;
  /** D-136 §A.6 — failure-retry counter. P6 wires the consumers; P2
   *  ships the column at `0` default. */
  failure_attempt_count: number;
  last_failure_reason: string | null;
  /** D-136 §A.6 — historical chain. Self-FK to the next row that
   *  supersedes this one for the same `(target_id, topic)`. */
  superseded_by_id: string | null;
  /** D-136 §A.6 — tombstone metadata. Populated when the cascade
   *  engine removes the row's effective contribution without dropping
   *  it from the table (preserves history). */
  tombstoned_at: number | null;
  tombstone_reason: string | null;
  /** D-136 §A.6 — sorted JSON array of upstream `_id` values consumed
   *  during compute. Empty / null for per-record producers; populated
   *  at P3 for aggregate / perspective / upstream-consuming producers. */
  input_enrichment_row_ids: string | null;
  /** D-128 — denormalised snapshot of canonical fields on a
   *  platform-resident record (deal name / status / amount / …).
   *  NULL on every row whose scope is not a platform-reference scope
   *  (closed-list `mail` / `contact` / `calendar` / `file` / three
   *  `connection.*` rows) and also on platform-reference rows the
   *  reconciler hasn't refreshed yet. */
  meta: EnrichmentMeta | null;
  /** D-128 — forward-compat slot for full-record local-mirror
   *  activation. Always NULL at D-128 — substrate is
   *  intelligence-by-reference, not full local mirror. Reserved for a
   *  future post-launch D where users opt-in (per-connection setting)
   *  to local full-record storage. */
  mirror_blob_hash: string | null;
  /** D-136 §A.9 P5 — logical id for shape-B (derived_entity) rows.
   *  Equals `_id` for overwrite-mode rows (legacy + non-historical
   *  topics); diverges under `mode: 'supersede'` where each chain
   *  row carries a fresh UUID `_id` while sharing the same logical
   *  `derived_entity_id`. NULL on shape-A rows. */
  derived_entity_id: string | null;
  /** D-136 §A.9 / §A.11 P5 — pinned flag set when a user-correction
   *  vote (P7) writes the row via `mode: 'pinned'`. Cascade engine
   *  skips pinned rows when enqueuing recompute so the user's pin
   *  isn't trampled by a subsequent producer pass. P5 ships the
   *  storage flag + privilege gate; P7 wires the `vote.write`
   *  consumer that emits these writes + the cascade-side respect. */
  is_pinned: boolean;
  /** D-161 P1 — the actor of the execution that WROTE this row,
   *  propagated from the run's `ExecutionSource.actor` (I-6). Housekeeping
   *  producers + vendor reconcilers — the bulk of enrichment writes —
   *  carry `'system'`; a recipe-driven `enrichment-upsert` invoked by an
   *  MCP agent carries `'contracted_user'`, a Reception-triggered one
   *  `'anonymous'`. The provenance facet P2 input-trust + P3 timeline
   *  lanes read. NOT the source record's content authorship (D-139). */
  origin_actor: Actor;
  /** D-161 P1 — the contract in force on the writing execution, when
   *  contracted; NULL for `'system'` / unrestricted-`user_self` writes. */
  origin_contract_id: string | null;
}

/** Input shape for `upsert`. Caller supplies the topic + the
 *  shape-specific key + the value; the store stamps `_id` / timestamps
 *  / staleness automatically. Per-record writes pass `scope` +
 *  `target_id`; derived-entity writes pass `derived_entity_id`
 *  (becomes `_id`) and leave `scope` / `target_id` undefined. */
export interface EnrichmentUpsertInput {
  topic: string;
  scope?: EnrichmentScope;
  target_id?: string;
  /** Shape B only — explicit derived-entity id. Ignored for Shape A. */
  derived_entity_id?: string;
  value: unknown;
  authored_by: string;
  source_record_hash?: string;
  recipe_hash?: string;
  /** D-136 P2 — renamed from legacy `model_used`. Producers continue
   *  passing the ingredient slug (`'ai-classify'`, `'ai-extract'`, …)
   *  until the P3 wrapper retrofit threads model identity correctly. */
  ingredient_slug?: string;
  /** D-136 P2 — resolved provider model id. Populated by the
   *  ForceLayer resolver at producer call time once P3 lands. */
  model_id?: string;
  event_at?: number;
  /** D-136 P2 — bistemporal stamping. `as_of` snapshots producer
   *  compute time; `last_evaluated_at` is auto-stamped to `now` on
   *  every upsert (insert + update) so a dedup-hit pass refreshes it. */
  as_of?: number;
  /** D-136 §A.3 — dedup hashes. Per-record producers may set
   *  `input_fingerprint_hash = source_record_hash`; aggregate /
   *  perspective producers must compose explicitly. P3 retrofits. */
  producer_version_hash?: string;
  input_fingerprint_hash?: string;
  /** D-136 §A.6 — `[0, 1]` fraction of expected sources contributed.
   *  NULL on scenario rows; REQUIRED on perspective writes once the
   *  validator gate lands (P5). */
  input_completeness?: number;
  /** D-136 §A.6 — sorted array of upstream `_id` values consumed
   *  during compute. Aggregate / perspective / upstream-consuming
   *  producers populate at P3; empty for per-record producers. */
  input_enrichment_row_ids?: ReadonlyArray<string>;
  /** Optional sidecar payload: pre-serialized embedding bytes (for
   *  `vector_index` topics) or a freeform indexable string (for `fts`
   *  topics). Topics whose `sidecar = 'none'` ignore this. */
  sidecar_vector?: Buffer;
  sidecar_text?: string;
  /** D-128 — denormalised snapshot of canonical fields on the platform
   *  record this enrichment references. Producers writing a topic with
   *  a platform-reference scope (`connection.api.<vendor>.<entity>`)
   *  pass the meta they read off the slim-record fetch in the
   *  reconciliation harness. Throws `MetaSnapshotTooLargeError` when
   *  serialised meta exceeds `PLATFORM_REFERENCE_META_MAX_BYTES`. */
  meta?: EnrichmentMeta;
  /** D-136 §A.9 P5 — kernel `enrichment-upsert` writer mode.
   *
   *  - Omitted / `'overwrite'` — replace the chain head in place.
   *    Default for every non-`'historical'` lifecycle policy.
   *    Rejected when the topic's `lifecycle_policy === 'historical'`.
   *  - `'supersede'` — append a new chain head + flip the prior
   *    head's `superseded_by_id` forward. Auto-defaulted when the
   *    topic's `lifecycle_policy === 'historical'`. Rejected on
   *    non-`'historical'` topics.
   *  - `'pinned'` — user-correction write. Privilege-gated: the
   *    `authored_by` value must start with `'system.user_correction'`
   *    (composed by P7's `vote.write` consumer). Stamps `is_pinned`
   *    true so cascade-driven recompute paths skip the row. */
  mode?: EnrichmentUpsertMode;
  /** D-161 P1 — write-actor for the row's origin provenance facet. The
   *  recipe-driven kernel `enrichment-upsert` handler threads the run's
   *  actor (from `StepMeta.actor`); housekeeping producers + vendor
   *  reconcilers omit it and the store stamps `'system'` (the
   *  conservative engine-internal default — A.5). */
  origin_actor?: Actor;
  /** D-161 P1 — contract in force on the writing execution, when
   *  contracted. Threaded alongside `origin_actor`; absent for
   *  `'system'` / unrestricted writes. */
  origin_contract_id?: string;
}

export interface EnrichmentListQuery {
  topic: string;
  scope?: EnrichmentScope;
  target_id?: string;
  /** When set, narrow to rows authored by this recipe id. */
  authored_by?: string;
  /** Only rows where `staleness_class = 'fresh'`. Default true — stale
   *  / expired rows are rarely useful to consumers; set false when the
   *  cascade engine needs to sweep them. */
  fresh_only?: boolean;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

// ────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────

export class EnrichmentTopicUnknownError extends Error {
  constructor(topic: string) {
    super(`enrichment_topic_unknown: ${topic}`);
    this.name = 'EnrichmentTopicUnknownError';
  }
}

export class EnrichmentScopeUnsupportedError extends Error {
  constructor(topic: string, scope: string) {
    super(`enrichment_scope_unsupported: topic '${topic}' does not support scope '${scope}'`);
    this.name = 'EnrichmentScopeUnsupportedError';
  }
}

export class EnrichmentValueInvalidError extends Error {
  readonly issues: string[];
  constructor(topic: string, issues: string[]) {
    super(`enrichment_value_invalid: topic '${topic}' value failed validation — ${issues.join('; ')}`);
    this.name = 'EnrichmentValueInvalidError';
    this.issues = issues;
  }
}

export class EnrichmentShapeMismatchError extends Error {
  constructor(topic: string, reason: string) {
    super(`enrichment_shape_mismatch: topic '${topic}' — ${reason}`);
    this.name = 'EnrichmentShapeMismatchError';
  }
}

/** D-136 §A.9 P5 — recipe used `mode: 'pinned'` without the
 *  `system.user_correction` `authored_by` prefix that P7's vote
 *  consumer composes. The kernel `enrichment-upsert` rpc / store
 *  rejects so a stray third-party recipe can't fabricate a pinned
 *  row that suppresses housekeeping recompute. */
export class EnrichmentModeUnauthorizedError extends Error {
  constructor(authored_by: string) {
    super(
      `enrichment_mode_unauthorized: mode 'pinned' requires authored_by ` +
        `to start with '${ENRICHMENT_PINNED_AUTHOR_PREFIX}' — got '${authored_by}'`,
    );
    this.name = 'EnrichmentModeUnauthorizedError';
  }
}

/** D-136 §A.9 P5 — `mode` flag is incompatible with the topic's
 *  `lifecycle_policy`. Two cases:
 *    - `mode: 'supersede'` requested on a non-`'historical'` topic.
 *    - `mode: 'overwrite'` requested on a `'historical'` topic
 *      (must be explicit `'supersede'` or `'pinned'`).
 *  Caller (handler / recipe) corrects by either omitting the flag
 *  (auto-defaults follow the policy) or matching it to the policy. */
export class EnrichmentModeInvalidForPolicyError extends Error {
  readonly topic: string;
  readonly mode: EnrichmentUpsertMode;
  readonly lifecycle_policy: string;
  constructor(
    topic: string,
    mode: EnrichmentUpsertMode,
    lifecycle_policy: string,
  ) {
    super(
      `enrichment_mode_invalid_for_policy: topic '${topic}' has ` +
        `lifecycle_policy '${lifecycle_policy}'; mode '${mode}' is rejected ` +
        `(historical → 'supersede' or 'pinned'; non-historical → 'overwrite' or 'pinned')`,
    );
    this.name = 'EnrichmentModeInvalidForPolicyError';
    this.topic = topic;
    this.mode = mode;
    this.lifecycle_policy = lifecycle_policy;
  }
}

// ────────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────────

/** Install the `data_enrichment` table + sidecars + indexes. Idempotent;
 *  safe to call on every boot. Sidecar tables are created
 *  unconditionally — they're cheap empty and let the store wire FK
 *  cascades without conditional schema branches.
 *
 *  D-128 — additive migration adds the `meta` (JSON snapshot, ≤ 8 KB)
 *  + `mirror_blob_hash` (forward-compat slot, always-NULL at D-128)
 *  columns. Both nullable; rows pre-D-128 stay valid with NULL on
 *  both.
 *
 *  D-136 P2 — fresh CREATE TABLE drops legacy `model_used` + `stale`,
 *  ships `ingredient_slug` + `model_id` + `staleness_class` plus the
 *  bistemporal / dedup / lifecycle columns from §A.6. Pre-launch zero
 *  installs lets the column drops happen unconditionally; the ALTER
 *  pass below reconciles dev DBs that already exist with the legacy
 *  shape. New indexes for the dedup primary key, the action-pending
 *  sweep, the as_of timeline read, and the supersede chain. */
export const ensureEnrichmentSchema = (db: Database.Database): void => {
  // Phase 1 — fresh CREATE TABLE for every base table. CREATE TABLE
  // IF NOT EXISTS is a no-op on legacy DBs; the column reconciliation
  // happens in phase 2 below before any new indexes touch the new
  // columns. Index creation is intentionally postponed to phase 3.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ENRICHMENT_TABLE} (
      _id                       TEXT PRIMARY KEY,
      topic                     TEXT NOT NULL,
      scope                     TEXT,
      target_id                 TEXT,
      derived_entity_id         TEXT,
      -- D-136 P6 — value is nullable. Failure-placeholder rows
      -- (first-attempt failures with no prior write) carry NULL until
      -- a successful re-derive lands. Tombstone-with-id rows (audit
      -- 10.2) NULL the column on cleanup so callers can no longer
      -- read the formerly-cached payload while _id + event_at
      -- preserve the D-120 link graph. Pre-D-136 column shape was
      -- TEXT NOT NULL; pre-launch zero installs lets the constraint
      -- relax happen in-place. Dev DBs created against the older
      -- shape need to be wiped (no migration code).
      value                     TEXT,
      authored_by               TEXT NOT NULL,
      source_record_hash        TEXT,
      recipe_hash               TEXT,
      ingredient_slug           TEXT,
      model_id                  TEXT,
      event_at                  INTEGER,
      ingested_at               INTEGER NOT NULL,
      authored_at               INTEGER NOT NULL,
      as_of                     INTEGER,
      last_evaluated_at         INTEGER,
      producer_version_hash     TEXT,
      input_fingerprint_hash    TEXT,
      input_completeness        REAL,
      staleness_class           TEXT NOT NULL DEFAULT 'fresh',
      lifecycle_action_pending  TEXT,
      failure_attempt_count     INTEGER NOT NULL DEFAULT 0,
      last_failure_reason       TEXT,
      superseded_by_id          TEXT,
      tombstoned_at             INTEGER,
      tombstone_reason          TEXT,
      input_enrichment_row_ids  TEXT,
      is_pinned                 INTEGER NOT NULL DEFAULT 0,
      meta                      TEXT,
      mirror_blob_hash          TEXT,
      -- D-161 P1 — origin provenance facet. origin_actor is NOT NULL
      -- DEFAULT 'system' so every row carries a non-null write-actor
      -- (I-5) even on inserts that omit it (the failure-placeholder
      -- path, legacy rows); the upsert path overrides with the run's
      -- real actor. origin_contract_id is nullable — present iff the
      -- writing source carried a contract_id (N.4).
      origin_actor              TEXT NOT NULL DEFAULT 'system',
      origin_contract_id        TEXT
    );

    CREATE TABLE IF NOT EXISTS ${VECTOR_INDEX_TABLE} (
      enrichment_id TEXT NOT NULL PRIMARY KEY,
      vector        BLOB NOT NULL,
      FOREIGN KEY (enrichment_id) REFERENCES ${ENRICHMENT_TABLE}(_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ${FTS_TABLE} (
      enrichment_id TEXT NOT NULL PRIMARY KEY,
      text          TEXT NOT NULL,
      FOREIGN KEY (enrichment_id) REFERENCES ${ENRICHMENT_TABLE}(_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ${QUALITY_VOTE_TABLE} (
      vote_id                TEXT PRIMARY KEY,
      topic                  TEXT NOT NULL,
      scope                  TEXT,
      target_id              TEXT,
      enrichment_row_id      TEXT NOT NULL,
      vote                   TEXT NOT NULL,
      source                 TEXT NOT NULL,
      corrected_value        TEXT,
      context_recipe_id      TEXT,
      voted_at               INTEGER NOT NULL,
      voted_by_client_id     TEXT NOT NULL,
      -- D-136 §A.13.7 P7 — sub-agent identity preserved through swarm
      -- decomposition. Both nullable; user-source votes always NULL.
      agent_session_id       TEXT,
      agent_sub_path         TEXT,
      -- D-136 §A.11 P7 — vote → lifecycle queue routing record. Captured
      -- at write time so the Settings UI / audit log can show how the
      -- system reacted without re-deriving from the row state.
      routing                TEXT,
      pinned_row_id          TEXT,
      -- P7.A Codex review #6 — ON DELETE CASCADE so existing hard-delete
      -- paths (deleteById / deleteForSource / reset(topic) / PSI baseline
      -- drop in topic-reset) don't fail with FOREIGN KEY constraint
      -- violations once any vote references the row. Votes lose their
      -- target row in cleanup contexts; the broader audit log preserves
      -- the vote-write event.
      FOREIGN KEY (enrichment_row_id) REFERENCES ${ENRICHMENT_TABLE}(_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ${EXTERNAL_CONTEXT_PULSE_TABLE} (
      context_id    TEXT PRIMARY KEY,
      pulse_value   TEXT NOT NULL,
      observed_at   INTEGER NOT NULL,
      next_check_at INTEGER
    );
  `);

  // Phase 2 — D-128 + D-136 P2 additive migrations for dev DBs that
  // exist pre-current-schema. `CREATE TABLE IF NOT EXISTS` skips when
  // the table already exists, so any column the legacy shape lacks
  // needs an ALTER pass. Pre-launch zero-installs (per
  // `feedback_pre_launch_no_migration.md`): no data backfill, no
  // compat shim — just bring the live schema up to current. ALTER
  // PASS MUST PRECEDE INDEX CREATION because new indexes reference
  // new columns (`staleness_class`, `lifecycle_action_pending`, …).
  const existingCols = db
    .prepare(`PRAGMA table_info(${ENRICHMENT_TABLE})`)
    .all() as { name: string }[];
  const colNames = new Set(existingCols.map((c) => c.name));

  // D-128 columns
  if (!colNames.has('meta')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN meta TEXT`);
  }
  if (!colNames.has('mirror_blob_hash')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN mirror_blob_hash TEXT`);
  }

  // D-161 P1 — origin provenance facet. origin_actor NOT NULL DEFAULT
  // 'system' brings existing dev-DB rows up to a non-null write-actor;
  // origin_contract_id nullable. Pre-launch zero installs — no backfill
  // beyond the column default.
  if (!colNames.has('origin_actor')) {
    db.exec(
      `ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN origin_actor TEXT NOT NULL DEFAULT 'system'`,
    );
  }
  if (!colNames.has('origin_contract_id')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN origin_contract_id TEXT`);
  }

  // D-136 P2 — drop legacy mis-populated `model_used` (audit §20.2)
  // and replace with `ingredient_slug` + `model_id`. SQLite ≥ 3.35
  // supports DROP COLUMN; better-sqlite3 12.x ships 3.45+.
  if (!colNames.has('ingredient_slug')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN ingredient_slug TEXT`);
  }
  if (!colNames.has('model_id')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN model_id TEXT`);
  }
  if (colNames.has('model_used')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} DROP COLUMN model_used`);
  }

  // D-136 P2 — bistemporal stamping
  if (!colNames.has('as_of')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN as_of INTEGER`);
  }
  if (!colNames.has('last_evaluated_at')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN last_evaluated_at INTEGER`);
  }

  // D-136 §A.3 — dedup hashes
  if (!colNames.has('producer_version_hash')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN producer_version_hash TEXT`);
  }
  if (!colNames.has('input_fingerprint_hash')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN input_fingerprint_hash TEXT`);
  }
  if (!colNames.has('input_completeness')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN input_completeness REAL`);
  }

  // D-136 §A.6 — three-state staleness class replaces binary `stale`.
  // SQLite ALTER TABLE ADD COLUMN with NOT NULL requires a non-NULL
  // default; `'fresh'` is the post-write canonical state. The drop of
  // legacy `stale` happens after the legacy `idx_enrichment_stale_sweep`
  // (which referenced it) is removed below.
  if (!colNames.has('staleness_class')) {
    db.exec(
      `ALTER TABLE ${ENRICHMENT_TABLE}
         ADD COLUMN staleness_class TEXT NOT NULL DEFAULT 'fresh'`,
    );
  }

  // D-136 §A.6 — lifecycle action / failure / supersede tracking
  if (!colNames.has('lifecycle_action_pending')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN lifecycle_action_pending TEXT`);
  }
  if (!colNames.has('failure_attempt_count')) {
    db.exec(
      `ALTER TABLE ${ENRICHMENT_TABLE}
         ADD COLUMN failure_attempt_count INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!colNames.has('last_failure_reason')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN last_failure_reason TEXT`);
  }
  if (!colNames.has('superseded_by_id')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN superseded_by_id TEXT`);
  }
  if (!colNames.has('tombstoned_at')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN tombstoned_at INTEGER`);
  }
  if (!colNames.has('tombstone_reason')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN tombstone_reason TEXT`);
  }
  if (!colNames.has('input_enrichment_row_ids')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN input_enrichment_row_ids TEXT`);
  }

  // D-136 §A.9 P5 — supersede mechanic + pinned-row flag.
  //
  //   `derived_entity_id` separates the shape-B logical key from the
  //   physical `_id`. Today (overwrite-mode) `_id == derived_entity_id`
  //   for every shape-B row, so the migration just copies `_id` into
  //   the new column for legacy rows. Under `mode: 'supersede'`, each
  //   chain row gets a fresh UUID `_id` while sharing the same
  //   `derived_entity_id` — the chain head is the row whose
  //   `superseded_by_id IS NULL`.
  //
  //   `is_pinned` flags rows authored by P7's `vote.write` consumer
  //   (`mode: 'pinned'`). The cascade engine skips pinned rows when
  //   enqueuing recompute so the user's correction isn't trampled.
  //   P5 ships the column + privilege gate; P7 wires the consumer +
  //   the cascade-side respect.
  if (!colNames.has('derived_entity_id')) {
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} ADD COLUMN derived_entity_id TEXT`);
    db.exec(
      `UPDATE ${ENRICHMENT_TABLE}
         SET derived_entity_id = _id
         WHERE scope IS NULL AND derived_entity_id IS NULL`,
    );
  }
  if (!colNames.has('is_pinned')) {
    db.exec(
      `ALTER TABLE ${ENRICHMENT_TABLE}
         ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0`,
    );
  }

  // D-136 §A.13.7 P7 — sub-agent identity preserved through swarm
  // decomposition. Both nullable; user-source votes always pass NULL.
  // Additive on the vote table; pre-launch dev DBs existing pre-P7
  // pick up the columns without migration. Reads `pragma_table_info`
  // independently of the enrichment column inspector above because
  // `colNames` snapshots the enrichment table only.
  const voteCols = new Set(
    (
      db.prepare(`PRAGMA table_info(${QUALITY_VOTE_TABLE})`).all() as { name: string }[]
    ).map((c) => c.name),
  );
  if (!voteCols.has('agent_session_id')) {
    db.exec(`ALTER TABLE ${QUALITY_VOTE_TABLE} ADD COLUMN agent_session_id TEXT`);
  }
  if (!voteCols.has('agent_sub_path')) {
    db.exec(`ALTER TABLE ${QUALITY_VOTE_TABLE} ADD COLUMN agent_sub_path TEXT`);
  }
  if (!voteCols.has('routing')) {
    db.exec(`ALTER TABLE ${QUALITY_VOTE_TABLE} ADD COLUMN routing TEXT`);
  }
  if (!voteCols.has('pinned_row_id')) {
    db.exec(`ALTER TABLE ${QUALITY_VOTE_TABLE} ADD COLUMN pinned_row_id TEXT`);
  }

  // P7.A Codex review #6 — vote table FK must be ON DELETE CASCADE so
  // existing hard-delete paths (deleteById / deleteForSource /
  // reset(topic) / PSI baseline drop in topic-reset) don't fail with
  // FOREIGN KEY constraint violations once any vote references the
  // row. SQLite has no ALTER TABLE ... DROP/ADD CONSTRAINT support,
  // so on legacy dev DBs we drop + recreate the table when the FK
  // lacks CASCADE. Pre-launch zero installs covers vote-row data loss
  // (the table is brand-new at P2; no production deployments yet).
  const voteFkRow = db
    .prepare(`PRAGMA foreign_key_list(${QUALITY_VOTE_TABLE})`)
    .get() as { on_delete?: string } | undefined;
  if (voteFkRow && voteFkRow.on_delete !== 'CASCADE') {
    db.exec(`DROP TABLE IF EXISTS ${QUALITY_VOTE_TABLE}`);
    db.exec(`
      CREATE TABLE ${QUALITY_VOTE_TABLE} (
        vote_id                TEXT PRIMARY KEY,
        topic                  TEXT NOT NULL,
        scope                  TEXT,
        target_id              TEXT,
        enrichment_row_id      TEXT NOT NULL,
        vote                   TEXT NOT NULL,
        source                 TEXT NOT NULL,
        corrected_value        TEXT,
        context_recipe_id      TEXT,
        voted_at               INTEGER NOT NULL,
        voted_by_client_id     TEXT NOT NULL,
        agent_session_id       TEXT,
        agent_sub_path         TEXT,
        routing                TEXT,
        pinned_row_id          TEXT,
        FOREIGN KEY (enrichment_row_id) REFERENCES ${ENRICHMENT_TABLE}(_id) ON DELETE CASCADE
      );
    `);
  }

  // D-136 §A.6 — drop the legacy `idx_enrichment_stale_sweep` (which
  // narrows on `stale = 1`) before dropping the column itself; the
  // new index covering `staleness_class` re-creates with the same
  // name in the index-creation pass below. Idempotent: DROP INDEX
  // IF EXISTS is a no-op on fresh DBs that never had the legacy
  // index.
  if (colNames.has('stale')) {
    db.exec(`DROP INDEX IF EXISTS idx_enrichment_stale_sweep`);
    db.exec(`ALTER TABLE ${ENRICHMENT_TABLE} DROP COLUMN stale`);
  }

  // Phase 3 — index creation. Runs after every new column is in place.
  // D-136 §A.9 P5 — both unique indexes filter on
  // `superseded_by_id IS NULL` so a `'historical'` topic's chain
  // tolerates multiple rows sharing the same logical key (only the
  // current head has NULL). Shape B keys on the new
  // `derived_entity_id` column rather than `_id` so the head pointer
  // walks chain rows whose physical `_id` is a fresh UUID. Drops first
  // — the legacy expression on dev DBs would otherwise silently
  // mismatch the new shape and reject supersede inserts.
  db.exec(`
    DROP INDEX IF EXISTS idx_enrichment_per_record_upsert;
    DROP INDEX IF EXISTS idx_enrichment_derived_upsert;

    CREATE UNIQUE INDEX idx_enrichment_per_record_upsert
      ON ${ENRICHMENT_TABLE} (topic, scope, target_id, authored_by)
      WHERE scope IS NOT NULL AND superseded_by_id IS NULL;

    CREATE UNIQUE INDEX idx_enrichment_derived_upsert
      ON ${ENRICHMENT_TABLE} (topic, derived_entity_id)
      WHERE scope IS NULL AND superseded_by_id IS NULL;

    CREATE INDEX IF NOT EXISTS idx_enrichment_per_record_read
      ON ${ENRICHMENT_TABLE} (scope, target_id);

    CREATE INDEX IF NOT EXISTS idx_enrichment_topic_listing
      ON ${ENRICHMENT_TABLE} (topic, ingested_at DESC);

    CREATE INDEX IF NOT EXISTS idx_enrichment_stale_sweep
      ON ${ENRICHMENT_TABLE} (staleness_class, topic)
      WHERE staleness_class != 'fresh';

    CREATE INDEX IF NOT EXISTS idx_enrichment_authored_by
      ON ${ENRICHMENT_TABLE} (authored_by);

    CREATE INDEX IF NOT EXISTS idx_enrichment_action_pending
      ON ${ENRICHMENT_TABLE} (lifecycle_action_pending)
      WHERE lifecycle_action_pending IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_enrichment_as_of
      ON ${ENRICHMENT_TABLE} (topic, as_of DESC)
      WHERE as_of IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_enrichment_superseded
      ON ${ENRICHMENT_TABLE} (superseded_by_id)
      WHERE superseded_by_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_enrichment_dedup_lookup
      ON ${ENRICHMENT_TABLE} (topic, scope, target_id, input_fingerprint_hash, producer_version_hash);

    CREATE INDEX IF NOT EXISTS idx_enrichment_fts_text
      ON ${FTS_TABLE} (text);

    CREATE INDEX IF NOT EXISTS idx_vote_topic
      ON ${QUALITY_VOTE_TABLE} (topic);

    CREATE INDEX IF NOT EXISTS idx_vote_row
      ON ${QUALITY_VOTE_TABLE} (enrichment_row_id);

    CREATE INDEX IF NOT EXISTS idx_vote_voted_at
      ON ${QUALITY_VOTE_TABLE} (voted_at DESC);
  `);

  // SQLite needs `PRAGMA foreign_keys = ON` per-connection so the FK
  // CASCADE actually fires on row deletes. Idempotent and cheap.
  db.exec('PRAGMA foreign_keys = ON');
};

// ────────────────────────────────────────────────────────────────
// Store interface
// ────────────────────────────────────────────────────────────────

export interface EnrichmentStore {
  upsert(input: EnrichmentUpsertInput): EnrichmentRecord;
  /** D-192 S4b — whether a per_record `topic` supports `scope`: its static
   *  `valid_scopes` OR a LIVE-registry pack CRM scope of the topic's `crm_alias`
   *  family (`connection.api.<packVendor>.contact` / `.deal` / `.account`). The
   *  SINGLE source of truth every scope gate consults — the upsert gate, the
   *  chain-walk gate, AND the `mcp.enrichment.read` handler — so a pack scope
   *  written via the widened upsert is also readable. `false` for an unknown or
   *  non-per_record topic (derived-entity topics carry no scope). */
  isScopeSupported(topic: string, scope: string): boolean;
  /** Convenience read keyed on shape-A primary triple. Returns the row
   *  authored by this recipe id, or null when absent. */
  getByRecord(
    topic: string,
    scope: EnrichmentScope,
    target_id: string,
    authored_by: string,
  ): EnrichmentRecord | null;
  /** Convenience read for derived entities. */
  getDerived(topic: string, derived_entity_id: string): EnrichmentRecord | null;
  /** D-145 § A.7.10 (PA9.7) — read the `vector_index` sidecar bytes
   *  by enrichment row id. Returns null when no sidecar row exists
   *  for the given enrichment_id. Used by the LLM result cache so an
   *  embedding cache hit can reuse the previously-computed vector
   *  buffer without re-calling the embedding adapter. */
  getSidecarVector(enrichment_id: string): Buffer | null;
  list(query: EnrichmentListQuery): EnrichmentRecord[];
  /** D-164 per-topic catalog membership — the distinct topics that
   *  currently hold at least one chain-head row (`superseded_by_id IS
   *  NULL`), alphabetically ordered. Deliberately NO staleness filter:
   *  `staleness_class` churns on invalidation cycles, and catalog
   *  membership must only move on first-write / total-delete events so
   *  the D-164 cacheable prefix stays byte-stable across turns. */
  listTopicsWithRows(): string[];
  /** D-128 — list every shape-A row for a `(scope, target_id)` source
   *  across all topics. Used by the reconciliation harness to pick up
   *  the freshest meta snapshot for hash-diff (without knowing which
   *  topics have written rows yet) and to bulk-update meta on a
   *  source-record change. Returns rows newest-first.
   *
   *  Default ordering is `ingested_at DESC` — the reconciler-friendly
   *  shape (most recent write wins). D-128 Phase 5 adds `axis: 'event'`
   *  for the `data.timeline()` consumer; the effective ts becomes
   *  `COALESCE(event_at, ingested_at)` and the optional `since`/`until`
   *  bounds apply against the same expression. The two ordering modes
   *  share one statement so the query plan stays predictable. */
  listByTarget(
    scope: EnrichmentScope,
    target_id: string,
    opts?: {
      limit?: number;
      /** D-128 Phase 5 — chronology axis. Default `'ingestion'`
       *  preserves the reconciler's recency-by-write semantics;
       *  `'event'` is the timeline-feed shape that respects
       *  bistemporal stamping (`COALESCE(event_at, ingested_at)`). */
      axis?: 'event' | 'ingestion';
      /** D-128 Phase 5 — inclusive lower bound on the effective ts.
       *  Pairs with `axis` so an event-axis caller's `since` filters
       *  on `COALESCE(event_at, ingested_at)`, not raw ingestion. */
      since?: number;
      /** D-128 Phase 5 — exclusive upper bound on the effective ts. */
      until?: number;
    },
  ): EnrichmentRecord[];
  /** D-128 — bulk-refresh the `meta` column on every shape-A row for
   *  `(scope, target_id)`. Used by the reconciliation harness when a
   *  slim-record diff lands so every existing row reflects the
   *  freshest snapshot. Throws `MetaSnapshotTooLargeError` when the
   *  serialised meta exceeds `PLATFORM_REFERENCE_META_MAX_BYTES` —
   *  caller (reconciler) handles by dropping or shrinking, never
   *  retrying. Returns the row count updated. */
  refreshMetaForTarget(
    scope: EnrichmentScope,
    target_id: string,
    new_meta: EnrichmentMeta,
  ): number;
  /** D-137 P2 § A.4 — list distinct platform-reference targets in
   *  `scope` keyed on their `meta` snapshot. Used by chat scope-search
   *  fan-out (`contact.search` / `deal.search`) to surface
   *  HubSpot / Salesforce records via their reconciler-refreshed meta
   *  (the canonical local-mirror view of a vendor record).
   *
   *  Picks the latest meta per `target_id` (max(`ingested_at`)
   *  chain-head row); rows whose `meta` column is NULL (legacy /
   *  pre-D-128 or a target the reconciler hasn't snapshotted yet)
   *  drop out. Ordered by max(`ingested_at`) DESC; capped at `limit`
   *  (default 50, max 200).
   *
   *  Freshness gate: only `staleness_class = 'fresh'` rows surface
   *  (mirrors the `EnrichmentListQuery.fresh_only` default). Cascade-
   *  flagged stale / expired rows drop so chat doesn't reference
   *  outdated CRM names / stages / owners before the next housekeeping
   *  recompute lands the refreshed `meta`.
   *
   *  Optional `name_contains` matches case-insensitively against
   *  `json_extract(meta, '$.name')`; `email_exact` exact-matches
   *  (lowercase) against `json_extract(meta, '$.email')`. Either
   *  filter implies the underlying JSON field is non-NULL; targets
   *  without the relevant meta key drop. Pure SQL — no in-memory
   *  filter on top.
   *
   *  D-190 `deal.search` union slice — `meta_equals` / `meta_ranges` push
   *  closed, canonical-field filters into the SAME SQL: each `{ path, value }`
   *  becomes `json_extract(meta, path) = value`, each `{ path, min?, max? }`
   *  the inclusive `>= ?` / `<= ?` bounds. On the materialized mirror every
   *  canonical field (incl. the live-derived `close_state`) is a plain stored
   *  JSON key, so all of them filter uniformly here. The `path` binds as a
   *  PARAMETER (injection-safe); callers draw it from a closed shared-vocab
   *  map. `limit` applies POST-filter (SQL `LIMIT` after `WHERE`), so the
   *  result honours both filter + cap — never an under-returning local trim.
   *
   *  Returns rows in `{ scope, target_id, meta }` shape — the smallest
   *  envelope chat fan-out needs to project into a contact / deal
   *  record without re-reading the row. The chain-head guarantee
   *  (`superseded_by_id IS NULL`) preserves D-136 historical-chain
   *  semantics so a fan-out doesn't surface stale supersededs. */
  listScopeMeta(
    scope: EnrichmentScope,
    opts?: {
      name_contains?: string;
      email_exact?: string;
      meta_equals?: ReadonlyArray<{ path: string; value: string }>;
      meta_ranges?: ReadonlyArray<{ path: string; min?: number; max?: number }>;
      limit?: number;
    },
  ): Array<{ scope: EnrichmentScope; target_id: string; meta: EnrichmentMeta }>;
  /** Delete an exact row by `_id`. Returns true when a row was removed.
   *  FK CASCADE handles sidecars automatically. */
  deleteById(id: string): boolean;
  /** Delete every shape-A row for a `(scope, target_id)` source. Used
   *  by the cascade engine on source-record delete. Returns the number
   *  of rows removed. */
  deleteForSource(scope: EnrichmentScope, target_id: string): number;
  /** D-192 source-data-removal — hard-delete every row under `scope` whose
   *  `target_id` starts with `target_id_prefix` (`LIKE '<prefix>%' ESCAPE`,
   *  escaped internally). The opt-in teardown purge of ONE connection's
   *  platform-reference enrichments within the vendor-SHARED
   *  `connection.api.<vendor>.<entity>` scope — the per-connection cut D-190
   *  put in `target_id` (`composeConnectionTargetIdPrefix`). Sidecars
   *  (vector_index / fts / votes) cascade via their FK. Returns rows deleted. */
  deleteForScopeAndTargetPrefix(scope: EnrichmentScope, target_id_prefix: string): number;
  /** D-192 — chain-head (`superseded_by_id IS NULL`) row ids for ONE
   *  connection within a vendor-shared scope: `scope = ? AND target_id LIKE
   *  '<prefix>%' ESCAPE` (escaped internally). `cascadeForConnectionDelete`
   *  tombstones exactly these on a connection delete — NOT the whole vendor
   *  scope (which would wipe a sibling connection's enrichment surface). */
  listChainHeadRowIdsByScopeAndTargetPrefix(
    scope: EnrichmentScope,
    target_id_prefix: string,
  ): string[];
  /** Mark every row authored by `authored_by` as stale. Used on recipe
   *  upgrade so consumers stop reading stale enrichments while
   *  producers re-run. Drops sidecars synchronously. Returns row count. */
  markStaleByAuthor(authored_by: string): number;
  /** Mark every shape-A row for `(scope, target_id)` as stale + drop
   *  sidecars. Used on source-record update for `dependent` topics. */
  markStaleForSource(scope: EnrichmentScope, target_id: string): number;
  /** Members-list cascade — for every row of `topic` whose value's
   *  `members_field` array contains `member_id`, remove the id. When
   *  the array empties, delete the row. Returns
   *  `{ trimmed, deleted }` counts. */
  trimMember(topic: string, member_id: string): { trimmed: number; deleted: number };
  /** D-136 P4 / §A.5 P5b — flip every chain-head, non-pinned, NULL-pending
   *  row of `topic` to `staleness_class = 'stale'` + `lifecycle_action_pending
   *  = action` + drops vector / FTS sidecars on the same row set.
   *  Idempotent on the steady-state set: repeat calls don't re-mark
   *  already-pending rows and don't overwrite a different pending action.
   *  Returns the row count actually updated.
   *
   *  Staleness flip + sidecar drop is load-bearing — without them the
   *  per-producer harness's stale-sweep (which iterates `staleness_class
   *  != 'fresh'` rows) would never re-derive the queued rows, and vector
   *  / FTS searches would surface stale content. Pre-P5b version only set
   *  LAP, which Codex P5b review flagged as "drain dispatches but
   *  producer never runs" silent-loss bug.
   *
   *  Callers: `confidence_drift_signal` producer (P4), cascade primitives
   *  `cascadeForConnectionDelete` + `cascadeForExternalContextPulseChange`
   *  (P5b). The lifecycle-queue drain consumer (P5b) tombstones discards;
   *  per-producer harness re-derives recompute rows on its next idle cycle. */
  enqueueLifecycleActionForTopic(
    topic: string,
    action: LifecycleActionPending,
  ): number;
  /** D-136 §A.5 P5b — count of would-be-affected rows for the topic-wide
   *  enqueue path. Used by the cascade governor's `reserveForTopic` to
   *  size the reservation against the real fan-out. Without this, the
   *  governor would reserve 1 slot but the SQL UPDATE would flip many
   *  rows, bypassing the per-topic queue-depth ceiling — Codex P5b
   *  review's "real fan-out size" finding. */
  countTopicEnqueueCandidates(topic: string): number;
  /** D-136 §A.7 P5b — list every chain-head row with a pending
   *  lifecycle action (for the walk-cap planner). Filters to chain
   *  heads (`superseded_by_id IS NULL`) so historical chain rows
   *  don't surface as queue work; pinned rows are filtered too since
   *  cascade primitives never enqueue them. Topic-narrowing optional —
   *  the planner narrows to AI-surface topics by passing `topic_in`.
   *  Order is stable (`topic, target_id ASC`) so plan re-runs are
   *  deterministic. */
  listLifecycleActionPending(opts?: {
    topic_in?: ReadonlyArray<string>;
    limit?: number;
  }): EnrichmentRecord[];
  /** D-136 §A.5 / §A.7 P5b — count of pending rows per topic. Drives
   *  the cascade fan-out budget's per-topic queue-depth ceiling
   *  (returns 0 for topics with no pending work). Returns `{topic,
   *  count}` for every topic with a pending row; topics without
   *  pending work are omitted from the result. */
  countLifecycleActionPendingByTopic(): ReadonlyArray<{ topic: string; count: number }>;
  /** D-136 §A.5 P5 — cascade primitive store hooks (low-level SQL
   *  operations driven by the `enrichment-cascade.ts` engine).
   *
   *  Every action listed below skips pinned rows (`is_pinned = 1`)
   *  per spec §A.11 — manual user corrections are protected from
   *  cascade-driven recompute.
   *
   *  Idempotency is column-state-driven: `markStaleAndEnqueueByRowIds`
   *  filters `WHERE lifecycle_action_pending IS NULL` so a second
   *  cascade call against the same row (out-of-order webhook,
   *  bundle-restore replay) is a no-op. Same shape as P4's
   *  `enqueueLifecycleActionForTopic`. */

  /** Find every chain-head row whose `input_enrichment_row_ids`
   *  array contains `upstream_row_id`. Drives
   *  `cascadeForUpstreamEnrichment`. */
  listConsumerRowIdsOfUpstream(upstream_row_id: string): string[];

  /** Find every chain-head `_id` for `(topic, target_id ∈ identity_keys)`.
   *  Drives `cascadeForIdentityChange` per perspective topic the
   *  registry walk passes in. */
  listChainHeadRowIdsByTopicAndTargets(
    topic: string,
    target_ids: ReadonlyArray<string>,
  ): string[];

  /** Find every row whose `producer_version_hash = old_version_hash`.
   *  Drives `cascadeForProducerUpgrade`. The cascade engine passes
   *  `producer_kind` + `producer_name` for audit + future filtering;
   *  the SQL narrowing today only needs the hash since composing it
   *  already folds in kind + name + code + model + manifest. */
  listChainHeadRowIdsByProducerVersion(old_version_hash: string): string[];

  /** Find every chain-head row matching `(scope, target_id)` —
   *  used by `cascadeForConnectionDelete` to enumerate the scenario
   *  rows scoped directly to a connection record. */
  listChainHeadRowIdsByScopeAndTarget(scope: string, target_id: string): string[];

  /** Find every chain-head row whose scope matches `scope_prefix`
   *  followed by a `.` (LIKE 'prefix.%'). Used by
   *  `cascadeForConnectionDelete` for vendor-entity scopes
   *  (`connection.api.<vendor>.<entity>` family) — caller may also
   *  filter by `target_id` LIKE pattern via the
   *  `targetIdLikePattern` arg. */
  listChainHeadRowIdsByScopeAndTargetPattern(args: {
    scopePrefixDot?: string;
    scopeEquals?: string;
    targetIdLikePattern?: string;
  }): string[];

  /** Mark `staleness_class = 'stale'` + `lifecycle_action_pending = action`
   *  on the listed rows. Skips pinned + already-action-pending rows.
   *  Returns the count actually updated. */
  markStaleAndEnqueueByRowIds(
    row_ids: ReadonlyArray<string>,
    action: LifecycleActionPending,
  ): number;

  /** Tombstone the listed rows: set `tombstoned_at`, `tombstone_reason`,
   *  `staleness_class = 'expired'`, NULL the `value` column. Does NOT
   *  remove the row — `_id` + `event_at` survive so D-120 timeline /
   *  link-resolver lookups still work (audit §10.2 tombstone-with-id).
   *  Skips pinned rows. Returns the count tombstoned. */
  tombstoneRowIds(
    row_ids: ReadonlyArray<string>,
    reason: 'cascade_delete' | 'source_revoked' | 'ttl_expired' | 'user_discarded',
  ): number;

  /** D-136 §A.6 P6 / Codex review — list stale rows that are ELIGIBLE
   *  for re-derive on the per-producer harness's stale-sweep. Filters
   *  out:
   *    - Pinned rows (`is_pinned = 1`) — user corrections protected.
   *    - Superseded rows (`superseded_by_id IS NOT NULL`) — historical chain.
   *    - Tombstoned rows (`tombstoned_at IS NOT NULL`) — already cleaned up.
   *    - `lifecycle_action_pending = 'permanently_failed'` — backoff exhausted.
   *    - `lifecycle_action_pending = 'discard'` — drain tombstones.
   *    - `lifecycle_action_pending LIKE 'retry_at_<ts>'` AND `ts > now` —
   *      backoff window not yet open.
   *  Without the SQL-level filter the stale-sweep batch fills with
   *  ineligible rows ahead of older eligible work, starving recompute. */
  listStaleRowsForReDerive(args: {
    topic: string;
    scope: EnrichmentScope;
    authored_by: string;
    now: number;
    limit: number;
  }): EnrichmentRecord[];

  /** D-136 §A.6 / audit §9 P6 — record a producer failure for one row.
   *  Bumps `failure_attempt_count`, stamps `last_failure_reason`, and
   *  sets `lifecycle_action_pending` per the backoff schedule:
   *    attempts 1–4 → `'retry_at_<ts>'` with 2m / 8m / 30m / 2h waits
   *    attempt 5+   → `'permanently_failed'` (drain observes; no auto-retry)
   *  Inserts a placeholder row when none exists for the
   *  `(topic, scope, target_id, authored_by)` triple — value NULL,
   *  `staleness_class = 'stale'`, no source/version hash captured.
   *  Subsequent successful upsert path (re-derive after backoff) clears
   *  `failure_attempt_count` + `last_failure_reason` + LAP via the
   *  existing update statements (P5b Item 4 substrate change). Returns
   *  the row id + new attempt count + assigned LAP token. */
  recordProducerFailure(args: {
    topic: string;
    scope: EnrichmentScope;
    target_id: string;
    authored_by: string;
    reason: string;
    source_record_hash?: string;
    now?: number;
  }): { row_id: string; attempt_count: number; lifecycle_action: string };

  /** Hard-delete every row for the given topic across the entire
   *  warehouse. Used by housekeeping `reset` (D-124) and tests. */
  reset(topic: string): number;
  /** Total row count — used by Settings → Housekeeping rendering. */
  count(): number;
  /** Total row count for a single topic. */
  countForTopic(topic: string): number;
  /** D-136 §A.13.1 P7.D — latest `COALESCE(event_at, ingested_at)` for
   *  the topic across every row + every author chain. Drives the
   *  registry-describe `coverage.latest_event_at` field — agents use
   *  this to gauge how recent the warehouse's view of the topic is.
   *  Returns null when the topic has no rows. */
  getLatestEventAtForTopic(topic: string): number | null;

  /** D-136 §A.11 P7 — fetch one row by `_id`. Used by the vote
   *  consumer to pull the target row's `topic` / `scope` / `target_id`
   *  / `authored_by` before routing. Returns null when the row is
   *  unknown. */
  getById(id: string): EnrichmentRecord | null;

  /** D-136 §A.13.3 P7.C — historical-chain time-travel resolver. Walks
   *  the supersede chain for `(topic, scope, target_id)` (Shape A) or
   *  `(topic, derived_entity_id)` (Shape B) and returns the row whose
   *  effective-time interval `[event_at, superseded_event_at)` covers
   *  `as_of`.
   *
   *  The `superseded_event_at` upper bound is derived from the
   *  supersede link, NOT from the implicit ordering of effective times.
   *  Each row's interval ends at its successor's effective time (the
   *  effective time of the row whose `_id = current.superseded_by_id`),
   *  or `+∞` for the chain head (`superseded_by_id IS NULL`). This
   *  semantic is correct under non-monotonic chains — backfill writes
   *  whose new head has an OLDER `event_at` than its predecessor still
   *  resolve correctly: the predecessor's interval `[event_at,
   *  successor.event_at)` is empty (since `event_at >=
   *  successor.event_at`) so it covers no `as_of`; the head's
   *  `[head.event_at, +∞)` is the canonical answer.
   *
   *  Effective time is `COALESCE(event_at, ingested_at)` — rows without
   *  an explicit `event_at` (legacy + producers that don't stamp event
   *  time) fall back to ingestion time so the walk stays defined.
   *
   *  Multi-author shape A: when `authored_by` is omitted, the resolver
   *  picks the freshest covering row across every author chain (matches
   *  the `data.enrichment.<scope>.<id>.<topic>` recipe-resolver
   *  convention from `enrichment-resolver.ts`). Pass `authored_by` to
   *  narrow to a single chain.
   *
   *  Tombstoned rows surface as-is (preserve `_id` + `event_at` per
   *  audit §10.2; the row's `value` is NULL + `tombstoned_at` is
   *  populated). Callers interpret a tombstoned `as_of` row as
   *  "the warehouse held this fact at T0; the user has since
   *  discarded it".
   *
   *  Returns null when no chain row's interval covers `as_of` (the
   *  read predates the first write OR every row's interval is empty
   *  after a supersede chain whose newer rows have older event times).
   *
   *  D-136 P7.D Codex review fix — `exclude_pinned: true` filters
   *  substrate-private rows (`is_pinned = 1` OR `authored_by LIKE
   *  'system.user_correction%'`) from the candidate set BEFORE picking
   *  the covering row. Used by `mcp.enrichment.read` so user-correction
   *  pin chains never surface to MCP per spec §A.13.5; absent default
   *  preserves the existing recipe-side resolver semantic (multi-author
   *  picks freshest including pins). */
  getRowAsOf(args: {
    topic: string;
    scope?: EnrichmentScope;
    target_id?: string;
    derived_entity_id?: string;
    authored_by?: string;
    as_of: number;
    /** D-136 P7.D Codex review fix — drop substrate-private (pinned)
     *  rows from the candidate set. */
    exclude_pinned?: boolean;
  }): EnrichmentRecord | null;

  /** D-136 §A.13.3 P7.C — full historical chain. Returns every row in
   *  the supersede chain for `(topic, scope, target_id)` (Shape A) or
   *  `(topic, derived_entity_id)` (Shape B), ordered by effective time
   *  `COALESCE(event_at, ingested_at) DESC` with `ingested_at DESC` as
   *  tie-breaker (head first → oldest ancestor last).
   *
   *  Multi-author shape A: when `authored_by` is omitted, returns rows
   *  from every author chain merged into one DESC ordering. Pass
   *  `authored_by` to narrow to a single chain.
   *
   *  Tombstoned rows are included so audit / Memory consumers see the
   *  full history including discards. Default `limit = 100`; max
   *  `1000`. */
  getChain(args: {
    topic: string;
    scope?: EnrichmentScope;
    target_id?: string;
    derived_entity_id?: string;
    authored_by?: string;
    /** D-136 P7.D Codex review fix — drop substrate-private (pinned)
     *  rows from the chain. Used by `mcp.enrichment.read` so the chain
     *  view never surfaces pinned correction rows per spec §A.13.5. */
    exclude_pinned?: boolean;
    limit?: number;
  }): EnrichmentRecord[];

  /** D-136 §A.11 P7 — write a quality-vote row + route per kind:
   *    - `'wrong' | 'stale'` → enqueue `lifecycle_action_pending =
   *       'recompute'` on the target row (or `'discard'` when the
   *       topic's lifecycle policy disallows recompute — TTL /
   *       one-shot). Pinned target rows are protected: routing
   *       collapses to `'noop'`.
   *    - `'corrected'` → write a new pinned row keyed on
   *       `(topic, scope|null, target_id|derived_entity_id, authored_by)`
   *       where `authored_by = ENRICHMENT_PINNED_AUTHOR_PREFIX +
   *       '.' + vote_id`. Returns the new row's `_id`.
   *    - `'correct'` → reset the target row's `failure_attempt_count`
   *       + `last_failure_reason` (UI nudges D-132 promotion banner;
   *       store-side change is the counter clear).
   *    - `'irrelevant'` → persist vote only.
   *
   *  The vote table FK reference is the enrichment row id supplied by
   *  the caller; the store throws when the row is unknown so the
   *  handler can surface a clear error. The handler is responsible
   *  for the source-vs-client validation matrix; the store just
   *  records what it's told. */
  writeQualityVote(args: {
    topic: string;
    scope?: EnrichmentScope;
    target_id?: string;
    enrichment_row_id: string;
    vote: import('@recued/contracts').EnrichmentVoteKind;
    source: import('@recued/contracts').EnrichmentVoteSource;
    corrected_value?: unknown;
    context_recipe_id?: string;
    voted_by_client_id: string;
    agent_session_id?: string;
    agent_sub_path?: string;
    voted_at?: number;
  }): {
    vote_id: string;
    routing:
      | 'recompute'
      | 'discard'
      | 'pin_written'
      | 'failure_count_reset'
      | 'noop';
    pinned_row_id: string | null;
  };

  /** D-136 §A.11 P7 — vote unwind. Removes the vote row + (when the
   *  vote was `'corrected'`) tombstones the user-pinned row that was
   *  created. Returns whether a pinned row was unwound (false when the
   *  vote was non-`'corrected'`). Returns false outright when the
   *  vote_id is unknown — idempotent on missing votes. */
  deleteQualityVote(vote_id: string): { ok: true; pin_unwound: boolean };

  /** D-136 §A.11 P7 — fetch a single vote row by id. Used by the
   *  delete handler to check whether a pinned-row unwind is needed +
   *  by the audit / Settings surfaces. */
  getQualityVote(vote_id: string):
    | {
        vote_id: string;
        topic: string;
        scope: EnrichmentScope | null;
        target_id: string | null;
        enrichment_row_id: string;
        vote: import('@recued/contracts').EnrichmentVoteKind;
        source: import('@recued/contracts').EnrichmentVoteSource;
        corrected_value: unknown;
        context_recipe_id: string | null;
        voted_at: number;
        voted_by_client_id: string;
        agent_session_id: string | null;
        agent_sub_path: string | null;
        routing: string | null;
        pinned_row_id: string | null;
      }
    | null;

  /** D-136 §A.11 P7 — list votes filtered by topic / row / source.
   *  Used by Settings UI surfaces (per-topic wrong-vote rate, per-row
   *  vote history) and the future auto-promotion threshold check
   *  (>5% wrong-vote rate). Defaults newest-first. */
  listQualityVotes(filter: {
    topic?: string;
    enrichment_row_id?: string;
    source?: import('@recued/contracts').EnrichmentVoteSource;
    vote?: import('@recued/contracts').EnrichmentVoteKind;
    limit?: number;
  }): Array<{
    vote_id: string;
    topic: string;
    scope: EnrichmentScope | null;
    target_id: string | null;
    enrichment_row_id: string;
    vote: import('@recued/contracts').EnrichmentVoteKind;
    source: import('@recued/contracts').EnrichmentVoteSource;
    corrected_value: unknown;
    context_recipe_id: string | null;
    voted_at: number;
    voted_by_client_id: string;
    agent_session_id: string | null;
    agent_sub_path: string | null;
    routing: string | null;
    pinned_row_id: string | null;
  }>;

  // ── D-136 §A.12 P7 — topic reset substrate ────────────────────

  /** Count rows that would be tombstoned by `housekeeping.topic.reset`
   *  for `(topic, scope_filter?)`. Used by the dry-run path to
   *  surface impact before the user confirms. Pinned rows are
   *  reported separately (they're protected — never tombstoned). */
  countMatchingForReset(args: {
    topic: string;
    scope_filter?: EnrichmentScope;
  }): { rows_to_tombstone: number; pinned_protected: number };

  /** Count `confidence_drift_signal` baseline rows for the source
   *  topic — drives the dry-run preview when the topic emits
   *  confidence (only those topics carry PSI baselines). */
  countConfidenceDriftBaselinesForTopic(source_topic: string): number;

  /** Tombstone every non-pinned row matching `(topic, scope_filter?)`,
   *  drop sidecars synchronously, then set `lifecycle_action_pending
   *  = 'recompute'` on each tombstoned row so the next housekeeping
   *  cycle re-derives. Returns the row counts. Pinned rows are
   *  skipped (the user's correction is protected against bulk reset).
   *  This is the topic-reset confirm-path primitive. */
  tombstoneAndEnqueueRecomputeByTopic(args: {
    topic: string;
    scope_filter?: EnrichmentScope;
  }): {
    rows_tombstoned: number;
    rows_recompute_enqueued: number;
    pinned_skipped: number;
  };

  /** Drop every `confidence_drift_signal` row whose derived-entity id
   *  matches the source topic. The drift signal's `_id` IS the
   *  source-topic name (`extractDriftSignalSourceTopic` mirrors this).
   *  Returns the count deleted. */
  dropConfidenceDriftBaselinesForTopic(source_topic: string): number;

  close(): void;
}

// ────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────

export interface CreateEnrichmentStoreOptions {
  now?: () => number;
  newId?: () => string;
  /** D-192 S4b — the LIVE vendor-entity registry (built-ins + each installed
   *  pack's lifted entities, i.e. `liveVendorRegistry(localManifestStore)`), so a
   *  pack CRM's `crm_alias`-anchored enrichment scope (`connection.api.<vendor>.
   *  contact` / `.deal` / `.account`) becomes writable WITHOUT a per-topic
   *  `valid_scopes` code edit — the pure `valid_scopes` list can't see pack
   *  vendors (the enrichment-registry ↔ connection-vendors import cycle), so the
   *  backend store closes the gap where the live registry IS available. Absent →
   *  built-ins only (today's behaviour: only statically-declared scopes writable).
   *  Called only on the COLD path (a scope not in the static list), so a built-in
   *  write never pays for it. Re-evaluated per call so a runtime install/uninstall
   *  is reflected. NO engagement scope is ever writable here — engagement entities
   *  are read-side aggregation inputs only, never an enrichment topic's scope. */
  resolveVendorRegistry?: () => ReadonlyArray<ConnectionVendorEntity>;
}

export const createEnrichmentStore = (
  db: Database.Database,
  opts: CreateEnrichmentStoreOptions = {},
): EnrichmentStore => {
  ensureEnrichmentSchema(db);

  const now = opts.now ?? ((): number => Date.now());
  const newId = opts.newId ?? ((): string => `enr_${randomUUID()}`);
  const resolveVendorRegistry = opts.resolveVendorRegistry;

  // D-192 S4b — a per_record scope is writable iff STATICALLY declared OR a
  // live-registry scope of the topic's `crm_alias` family whose vendor is a PACK
  // vendor. This is the shared `isEnrichmentScopeSupported` (contracts) — the
  // SAME check the recipe VALIDATOR runs, so a pack CRM's mirror scope validates
  // exactly where it persists (they had drifted). Built-in behaviour is
  // byte-identical; unbound resolver → frozen builtin → no widening.
  const isScopeWritable = (def: EnrichmentDefinition, scope: EnrichmentScope): boolean =>
    isEnrichmentScopeSupported(
      def.valid_scopes,
      scope,
      resolveVendorRegistry?.() ?? CONNECTION_VENDOR_ENTITIES,
    );

  // D-136 §A.9 P5 — `derived_entity_id` is now an explicit column
  // (carries the shape-B logical key for both overwrite + supersede
  // mode) and `is_pinned` flags rows authored under `mode: 'pinned'`.
  const insertStmt = db.prepare(
    `INSERT INTO ${ENRICHMENT_TABLE}
       (_id, topic, scope, target_id, derived_entity_id, value, authored_by,
        source_record_hash, recipe_hash, ingredient_slug, model_id, event_at,
        ingested_at, authored_at, as_of, last_evaluated_at,
        producer_version_hash, input_fingerprint_hash, input_completeness,
        input_enrichment_row_ids, staleness_class, is_pinned, meta, mirror_blob_hash,
        origin_actor, origin_contract_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fresh', ?, ?, NULL, ?, ?)`,
  );

  // D-136 §A.9 P5 — overwrite-mode updates target the chain head
  // (`superseded_by_id IS NULL`). Non-historical topics never form
  // a chain so the predicate is a no-op there; on historical topics
  // overwrite mode is rejected upstream by the policy gate, so the
  // filter is defensive.
  //
  // D-136 §A.7 P5b — clears `lifecycle_action_pending` alongside the
  // staleness flip back to `'fresh'`. A successful upsert IS the
  // action's completion; leaving the queue marker would mean the
  // drain consumer keeps re-dispatching the row forever. Pinned
  // rows + retry-armed rows skip the recompute path elsewhere, so
  // unconditionally clearing here is safe.
  // D-136 §A.12 P7.B Codex review #2 — successful re-derive clears
  // `tombstoned_at` + `tombstone_reason`. A topic-reset confirms by
  // tombstoning the chain-head + setting LAP=recompute; the producer's
  // next stale-sweep walk picks the row up (per the
  // `listStaleRowsForReDerive` widening below) and runs through this
  // update path. Without the clear, the row would remain
  // tombstone-flagged after re-derive, contradicting the populated
  // value. The cascade-driven tombstones (source-revoked / TTL-expired
  // / cascade-delete) never see this path because their LAP is left
  // NULL or set to 'discard' — neither matches the recompute predicate.
  // `meta = COALESCE(?, meta)` — PRESERVE existing meta on a meta-less
  // upsert (both update paths). The D-128 reconciler snapshots the source
  // record (name / amount / stage / …) onto a target's enrichment rows via
  // `refreshMetaForTarget` (a separate UPDATE), and a producer re-upsert
  // arrives with no `meta`. Binding it plainly (`meta = ?` → NULL)
  // clobbered that snapshot, so a producer firing on the same `updated`
  // event as a meta-reading alert silently NULLed the values the alert
  // reads (`surface-stalling-deals-crm` → amount 0 → never notifies). The
  // bind is NULL iff `input.meta === undefined` (`serializeEnrichmentMeta`
  // never returns null for a provided value — it throws or returns JSON),
  // so COALESCE preserves exactly when meta wasn't supplied and overwrites
  // when it was. Producers never manage meta; the reconciler owns it.
  const updatePerRecordStmt = db.prepare(
    `UPDATE ${ENRICHMENT_TABLE}
       SET value = ?, source_record_hash = ?, recipe_hash = ?,
           ingredient_slug = ?, model_id = ?,
           event_at = ?, ingested_at = ?, authored_at = ?,
           as_of = ?, last_evaluated_at = ?,
           producer_version_hash = ?, input_fingerprint_hash = ?,
           input_completeness = ?, input_enrichment_row_ids = ?,
           staleness_class = 'fresh', lifecycle_action_pending = NULL,
           failure_attempt_count = 0, last_failure_reason = NULL,
           tombstoned_at = NULL, tombstone_reason = NULL,
           is_pinned = ?, meta = COALESCE(?, meta),
           origin_actor = ?, origin_contract_id = ?
       WHERE topic = ? AND scope = ? AND target_id = ? AND authored_by = ?
         AND superseded_by_id IS NULL`,
  );

  const updateDerivedStmt = db.prepare(
    `UPDATE ${ENRICHMENT_TABLE}
       SET value = ?, source_record_hash = ?, recipe_hash = ?,
           ingredient_slug = ?, model_id = ?,
           event_at = ?, ingested_at = ?, authored_at = ?,
           as_of = ?, last_evaluated_at = ?,
           producer_version_hash = ?, input_fingerprint_hash = ?,
           input_completeness = ?, input_enrichment_row_ids = ?,
           staleness_class = 'fresh', lifecycle_action_pending = NULL,
           failure_attempt_count = 0, last_failure_reason = NULL,
           tombstoned_at = NULL, tombstone_reason = NULL,
           is_pinned = ?, authored_by = ?, meta = COALESCE(?, meta),
           origin_actor = ?, origin_contract_id = ?
       WHERE topic = ? AND derived_entity_id = ? AND scope IS NULL
         AND superseded_by_id IS NULL`,
  );

  // D-136 §A.9 P5 — chain-head finder: returns the row that is
  // currently "the value" for `(topic, scope, target_id, authored_by)`.
  // For non-historical topics the chain has only one row, so the
  // `superseded_by_id IS NULL` filter is a no-op.
  const findPerRecordStmt = db.prepare(
    `SELECT * FROM ${ENRICHMENT_TABLE}
       WHERE topic = ? AND scope = ? AND target_id = ? AND authored_by = ?
         AND superseded_by_id IS NULL`,
  );

  // D-136 §A.9 P5 — keys on `derived_entity_id` (the logical key)
  // rather than `_id` (physical UUID under supersede mode).
  const findDerivedStmt = db.prepare(
    `SELECT * FROM ${ENRICHMENT_TABLE}
       WHERE topic = ? AND derived_entity_id = ? AND scope IS NULL
         AND superseded_by_id IS NULL`,
  );

  // D-136 §A.9 P5 — flips a chain row's `superseded_by_id` to the
  // newly-inserted head's `_id`. Used by the supersede path under
  // `lifecycle_policy: 'historical'`.
  const markRowSupersededStmt = db.prepare(
    `UPDATE ${ENRICHMENT_TABLE}
       SET superseded_by_id = ?
       WHERE _id = ?`,
  );

  const deleteByIdStmt = db.prepare(`DELETE FROM ${ENRICHMENT_TABLE} WHERE _id = ?`);

  const deleteForSourceStmt = db.prepare(
    `DELETE FROM ${ENRICHMENT_TABLE} WHERE scope = ? AND target_id = ?`,
  );

  // D-136 P2 — `staleness_class = 'stale'` replaces the binary
  // `stale = 1`. The cascade engine (P5) flips rows to `'expired'`
  // for TTL / tombstone events; the dependent-source mark stays at
  // `'stale'`.
  const markStaleByAuthorStmt = db.prepare(
    `UPDATE ${ENRICHMENT_TABLE}
       SET staleness_class = 'stale' WHERE authored_by = ?`,
  );

  const markStaleForSourceStmt = db.prepare(
    `UPDATE ${ENRICHMENT_TABLE}
       SET staleness_class = 'stale' WHERE scope = ? AND target_id = ?`,
  );

  const dropSidecarsForRowStmt = db.prepare(
    `DELETE FROM ${VECTOR_INDEX_TABLE} WHERE enrichment_id = ?`,
  );
  const dropFtsForRowStmt = db.prepare(
    `DELETE FROM ${FTS_TABLE} WHERE enrichment_id = ?`,
  );
  const insertVectorStmt = db.prepare(
    `INSERT OR REPLACE INTO ${VECTOR_INDEX_TABLE} (enrichment_id, vector) VALUES (?, ?)`,
  );
  const insertFtsStmt = db.prepare(
    `INSERT OR REPLACE INTO ${FTS_TABLE} (enrichment_id, text) VALUES (?, ?)`,
  );

  const resetStmt = db.prepare(`DELETE FROM ${ENRICHMENT_TABLE} WHERE topic = ?`);

  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM ${ENRICHMENT_TABLE}`);
  const countForTopicStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ${ENRICHMENT_TABLE} WHERE topic = ?`,
  );

  // ── Row → record ────────────────────────────────────────────────
  const rowToRecord = (row: Record<string, unknown>): EnrichmentRecord => ({
    _id: row._id as string,
    topic: row.topic as EnrichmentTopic,
    scope: (row.scope as EnrichmentScope | null) ?? null,
    target_id: (row.target_id as string | null) ?? null,
    value: parseValue(row.value as string),
    authored_by: row.authored_by as string,
    source_record_hash: (row.source_record_hash as string | null) ?? null,
    recipe_hash: (row.recipe_hash as string | null) ?? null,
    ingredient_slug: (row.ingredient_slug as string | null) ?? null,
    model_id: (row.model_id as string | null) ?? null,
    event_at: (row.event_at as number | null) ?? null,
    ingested_at: row.ingested_at as number,
    authored_at: row.authored_at as number,
    as_of: (row.as_of as number | null) ?? null,
    last_evaluated_at: (row.last_evaluated_at as number | null) ?? null,
    producer_version_hash: (row.producer_version_hash as string | null) ?? null,
    input_fingerprint_hash: (row.input_fingerprint_hash as string | null) ?? null,
    input_completeness: (row.input_completeness as number | null) ?? null,
    staleness_class: (row.staleness_class as EnrichmentStalenessClass | undefined) ?? 'fresh',
    lifecycle_action_pending: (row.lifecycle_action_pending as string | null) ?? null,
    failure_attempt_count: (row.failure_attempt_count as number | null) ?? 0,
    last_failure_reason: (row.last_failure_reason as string | null) ?? null,
    superseded_by_id: (row.superseded_by_id as string | null) ?? null,
    tombstoned_at: (row.tombstoned_at as number | null) ?? null,
    tombstone_reason: (row.tombstone_reason as string | null) ?? null,
    input_enrichment_row_ids: (row.input_enrichment_row_ids as string | null) ?? null,
    meta: deserializeEnrichmentMeta((row.meta as string | null) ?? null),
    mirror_blob_hash: (row.mirror_blob_hash as string | null) ?? null,
    derived_entity_id: (row.derived_entity_id as string | null) ?? null,
    is_pinned: ((row.is_pinned as number | null) ?? 0) === 1,
    // D-161 P1 — origin provenance facet. `origin_actor` is NOT NULL in
    // the schema (DEFAULT 'system'); the `?? 'system'` is belt-and-braces
    // for any pre-migration row read before the ALTER lands.
    origin_actor: (row.origin_actor as Actor | null) ?? 'system',
    origin_contract_id: (row.origin_contract_id as string | null) ?? null,
  });

  const parseValue = (raw: string): unknown => {
    try { return JSON.parse(raw); } catch { return raw; }
  };

  // ── Validation gates ────────────────────────────────────────────
  const validate = (
    topic: string,
    scope: EnrichmentScope | undefined,
    value: unknown,
  ): { def: EnrichmentDefinition; topicNarrow: EnrichmentTopic } => {
    if (!isEnrichmentTopic(topic)) {
      throw new EnrichmentTopicUnknownError(topic);
    }
    const def = getEnrichmentDefinition(topic);
    if (def.shape === 'per_record') {
      if (scope === undefined) {
        throw new EnrichmentShapeMismatchError(topic, 'per_record topics require a scope');
      }
      // D-192 S4b — static valid_scopes OR a live-registry crm_alias-family scope.
      if (!isScopeWritable(def, scope)) {
        throw new EnrichmentScopeUnsupportedError(topic, scope);
      }
    } else {
      if (scope !== undefined) {
        throw new EnrichmentShapeMismatchError(topic, 'derived_entity topics must omit scope');
      }
    }
    const result = def.value_schema(value);
    if (!result.ok) {
      throw new EnrichmentValueInvalidError(topic, result.issues);
    }
    return { def, topicNarrow: topic };
  };

  const writeSidecars = (
    id: string,
    def: EnrichmentDefinition,
    input: EnrichmentUpsertInput,
  ): void => {
    const sidecar = def.sidecar ?? 'none';
    if (sidecar === 'none') return;
    if (sidecar === 'vector_index' && input.sidecar_vector !== undefined) {
      insertVectorStmt.run(id, input.sidecar_vector);
    }
    if (sidecar === 'fts' && input.sidecar_text !== undefined) {
      insertFtsStmt.run(id, input.sidecar_text);
    }
  };

  // D-136 §A.9 P5 — resolve the effective writer shape + pinned flag
  // from the topic's `lifecycle_policy` + the caller's requested
  // `mode`. Privilege gate runs first so a third-party recipe trying
  // to fabricate a pinned row gets rejected before any policy check.
  const resolveWriterMode = (
    def: EnrichmentDefinition,
    requested: EnrichmentUpsertMode | undefined,
    authored_by: string,
    topic: string,
  ): { writerShape: 'overwrite' | 'supersede'; pinnedFlag: boolean } => {
    if (requested === 'pinned') {
      if (!authored_by.startsWith(ENRICHMENT_PINNED_AUTHOR_PREFIX)) {
        throw new EnrichmentModeUnauthorizedError(authored_by);
      }
      return {
        writerShape: def.lifecycle_policy === 'historical' ? 'supersede' : 'overwrite',
        pinnedFlag: true,
      };
    }
    if (def.lifecycle_policy === 'historical') {
      if (requested === 'overwrite') {
        throw new EnrichmentModeInvalidForPolicyError(topic, 'overwrite', def.lifecycle_policy);
      }
      return { writerShape: 'supersede', pinnedFlag: false };
    }
    if (requested === 'supersede') {
      throw new EnrichmentModeInvalidForPolicyError(topic, 'supersede', def.lifecycle_policy);
    }
    return { writerShape: 'overwrite', pinnedFlag: false };
  };

  // ── Public surface ──────────────────────────────────────────────
  const upsert = (input: EnrichmentUpsertInput): EnrichmentRecord => {
    const { def, topicNarrow } = validate(input.topic, input.scope, input.value);
    const ts = now();
    const serialized = JSON.stringify(input.value ?? null);
    // D-128 — serialise meta with size-cap rejection. Throws
    // `MetaSnapshotTooLargeError` when over 8 KB; producers handle
    // by dropping or shrinking, never retrying.
    const metaSerialized =
      input.meta !== undefined ? serializeEnrichmentMeta(input.meta) : null;

    // D-136 P2 — serialise the upstream-row-id list when present. P3
    // populates this for aggregate / perspective / upstream-consuming
    // producers; per-record producers leave it null.
    const inputRowIdsSerialized =
      input.input_enrichment_row_ids !== undefined &&
      input.input_enrichment_row_ids.length > 0
        ? JSON.stringify(input.input_enrichment_row_ids)
        : null;

    // D-136 §A.9 P5 — resolve writer shape + pinned flag. Throws
    // `EnrichmentModeUnauthorizedError` / `EnrichmentModeInvalidForPolicyError`
    // before any DB write.
    const { writerShape, pinnedFlag } = resolveWriterMode(
      def,
      input.mode,
      input.authored_by,
      topicNarrow,
    );
    const isPinnedInt = pinnedFlag ? 1 : 0;

    // D-161 P1 — origin provenance facet. Propagated from the run's actor
    // (threaded onto the input via the kernel `enrichment-upsert` handler)
    // when present; housekeeping producers + vendor reconcilers omit it →
    // SYSTEM_ORIGIN (`'system'`). Never re-derived (I-6). Stamped on every
    // insert + on overwrite-mode updates (the new write's actor wins).
    const origin = originProvenanceFromActor(
      input.origin_actor,
      input.origin_contract_id,
    );
    const originActor = origin.origin_actor;
    const originContractId = origin.origin_contract_id ?? null;

    if (def.shape === 'per_record') {
      const scope = input.scope!;
      if (typeof input.target_id !== 'string' || input.target_id.length === 0) {
        throw new EnrichmentShapeMismatchError(topicNarrow, 'per_record topics require target_id');
      }
      // Find the chain head. Both writer shapes need it: overwrite to
      // update in place; supersede to forward-link the prior head.
      const head = findPerRecordStmt.get(
        topicNarrow,
        scope,
        input.target_id,
        input.authored_by,
      ) as Record<string, unknown> | undefined;

      if (writerShape === 'overwrite' && head !== undefined) {
        updatePerRecordStmt.run(
          serialized,
          input.source_record_hash ?? null,
          input.recipe_hash ?? null,
          input.ingredient_slug ?? null,
          input.model_id ?? null,
          input.event_at ?? null,
          ts,
          ts,
          input.as_of ?? null,
          ts,
          input.producer_version_hash ?? null,
          input.input_fingerprint_hash ?? null,
          input.input_completeness ?? null,
          inputRowIdsSerialized,
          isPinnedInt,
          metaSerialized,
          originActor,
          originContractId,
          topicNarrow,
          scope,
          input.target_id,
          input.authored_by,
        );
        // Refresh sidecars — drop old + re-insert. Rare-enough path
        // (every upsert) that the simple shape beats diffing.
        const existingId = head._id as string;
        dropSidecarsForRowStmt.run(existingId);
        dropFtsForRowStmt.run(existingId);
        writeSidecars(existingId, def, input);
        const refreshed = findPerRecordStmt.get(
          topicNarrow, scope, input.target_id, input.authored_by,
        ) as Record<string, unknown>;
        return rowToRecord(refreshed);
      }

      // Supersede mode OR overwrite-with-no-head → INSERT a new row.
      // Under supersede, flip the prior head's `superseded_by_id`
      // BEFORE the insert so the unique partial index `(topic, scope,
      // target_id, authored_by) WHERE superseded_by_id IS NULL`
      // tolerates the moment between the two writes — the prior head
      // is no longer at the index, so the new row's NULL slots in.
      const id = newId();
      if (writerShape === 'supersede' && head !== undefined) {
        markRowSupersededStmt.run(id, head._id as string);
      }
      insertStmt.run(
        id,
        topicNarrow,
        scope,
        input.target_id,
        null /* derived_entity_id NULL on shape A */,
        serialized,
        input.authored_by,
        input.source_record_hash ?? null,
        input.recipe_hash ?? null,
        input.ingredient_slug ?? null,
        input.model_id ?? null,
        input.event_at ?? null,
        ts,
        ts,
        input.as_of ?? null,
        ts,
        input.producer_version_hash ?? null,
        input.input_fingerprint_hash ?? null,
        input.input_completeness ?? null,
        inputRowIdsSerialized,
        isPinnedInt,
        // The supersede analog of `meta = COALESCE(?, meta)` — a meta-less
        // producer write that SUPERSEDES a historical-topic head inserts a
        // NEW row, so the COALESCE on the overwrite UPDATE never runs; carry
        // the prior head's meta snapshot forward so the new chain head isn't
        // meta-NULL until the next reconciler refresh (the same clobber that
        // silently broke `notify-deal-closing-soon-crm` reading
        // `deal_health_score` meta). Explicit meta still wins.
        inheritMetaOnSupersede(metaSerialized, head),
        originActor,
        originContractId,
      );
      writeSidecars(id, def, input);
      const inserted = findPerRecordStmt.get(
        topicNarrow, scope, input.target_id, input.authored_by,
      ) as Record<string, unknown>;
      return rowToRecord(inserted);
    }

    // Shape B — derived entity. `derived_entity_id` is the logical key
    // (caller-supplied stable hash / well-known string); under
    // overwrite mode `_id == derived_entity_id` for the chain-head row;
    // under supersede mode each chain row gets a fresh UUID `_id`
    // while sharing the same `derived_entity_id`.
    if (typeof input.derived_entity_id !== 'string' || input.derived_entity_id.length === 0) {
      throw new EnrichmentShapeMismatchError(topicNarrow, 'derived_entity topics require derived_entity_id');
    }
    const logicalId = input.derived_entity_id;
    const head = findDerivedStmt.get(topicNarrow, logicalId) as
      | Record<string, unknown>
      | undefined;

    if (writerShape === 'overwrite' && head !== undefined) {
      updateDerivedStmt.run(
        serialized,
        input.source_record_hash ?? null,
        input.recipe_hash ?? null,
        input.ingredient_slug ?? null,
        input.model_id ?? null,
        input.event_at ?? null,
        ts,
        ts,
        input.as_of ?? null,
        ts,
        input.producer_version_hash ?? null,
        input.input_fingerprint_hash ?? null,
        input.input_completeness ?? null,
        inputRowIdsSerialized,
        isPinnedInt,
        input.authored_by,
        metaSerialized,
        originActor,
        originContractId,
        topicNarrow,
        logicalId,
      );
      const existingId = head._id as string;
      dropSidecarsForRowStmt.run(existingId);
      dropFtsForRowStmt.run(existingId);
      writeSidecars(existingId, def, input);
      const refreshed = findDerivedStmt.get(topicNarrow, logicalId) as Record<string, unknown>;
      return rowToRecord(refreshed);
    }

    // Supersede mode OR overwrite-with-no-head → INSERT.
    // Overwrite-with-no-head preserves the legacy contract that the
    // first write of a key uses `_id == derived_entity_id` (so direct
    // `_id` lookups in legacy code keep working). Supersede mints a
    // fresh UUID so the unique partial index `(topic, derived_entity_id)
    // WHERE superseded_by_id IS NULL` tolerates the chain shape — and
    // the supersede flip on the prior head MUST run BEFORE the insert
    // for the partial index to admit the new NULL row.
    const physicalId = writerShape === 'supersede' ? newId() : logicalId;
    if (writerShape === 'supersede' && head !== undefined) {
      markRowSupersededStmt.run(physicalId, head._id as string);
    }
    insertStmt.run(
      physicalId,
      topicNarrow,
      null /* scope NULL on shape B */,
      null /* target_id NULL on shape B */,
      logicalId,
      serialized,
      input.authored_by,
      input.source_record_hash ?? null,
      input.recipe_hash ?? null,
      input.ingredient_slug ?? null,
      input.model_id ?? null,
      input.event_at ?? null,
      ts,
      ts,
      input.as_of ?? null,
      ts,
      input.producer_version_hash ?? null,
      input.input_fingerprint_hash ?? null,
      input.input_completeness ?? null,
      inputRowIdsSerialized,
      isPinnedInt,
      // Same supersede meta-inheritance as Shape A.
      inheritMetaOnSupersede(metaSerialized, head),
      originActor,
      originContractId,
    );
    writeSidecars(physicalId, def, input);
    const inserted = findDerivedStmt.get(topicNarrow, logicalId) as Record<string, unknown>;
    return rowToRecord(inserted);
  };

  const getByRecord = (
    topic: string,
    scope: EnrichmentScope,
    target_id: string,
    authored_by: string,
  ): EnrichmentRecord | null => {
    if (!isEnrichmentTopic(topic)) return null;
    const row = findPerRecordStmt.get(topic, scope, target_id, authored_by) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRecord(row) : null;
  };

  const getDerived = (topic: string, derived_entity_id: string): EnrichmentRecord | null => {
    if (!isEnrichmentTopic(topic)) return null;
    const row = findDerivedStmt.get(topic, derived_entity_id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRecord(row) : null;
  };

  const list = (query: EnrichmentListQuery): EnrichmentRecord[] => {
    if (!isEnrichmentTopic(query.topic)) return [];
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);
    // D-136 §A.9 P5 — filter to chain heads. Under the supersede
    // mechanic, historical-chain rows keep `staleness_class = 'fresh'`
    // (they're not stale data, just no longer the current value); the
    // chain-head discriminator is `superseded_by_id IS NULL`. Without
    // this filter, two writes to a historical topic would surface both
    // rows as current results. The historical-chain reader (P7
    // `?as_of` / `include_historical`) is a separate path.
    const where: string[] = ['topic = ?', 'superseded_by_id IS NULL'];
    const args: (string | number)[] = [query.topic];
    if (query.scope !== undefined) {
      where.push('scope = ?');
      args.push(query.scope);
    }
    if (query.target_id !== undefined) {
      where.push('target_id = ?');
      args.push(query.target_id);
    }
    if (query.authored_by !== undefined) {
      where.push('authored_by = ?');
      args.push(query.authored_by);
    }
    if (query.fresh_only !== false) {
      where.push("staleness_class = 'fresh'");
    }
    const sql = `SELECT * FROM ${ENRICHMENT_TABLE}
                  WHERE ${where.join(' AND ')}
                  ORDER BY ingested_at DESC
                  LIMIT ? OFFSET ?`;
    args.push(limit, offset);
    const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  };

  // D-164 per-topic catalog membership. Index-served via
  // `idx_enrichment_topic_listing (topic, ingested_at DESC)` — the
  // DISTINCT collapses on the index's leading column. Runs once per
  // chat catalog build (per turn), bounded by topic cardinality.
  const listTopicsWithRowsStmt = db.prepare(
    `SELECT DISTINCT topic FROM ${ENRICHMENT_TABLE}
       WHERE superseded_by_id IS NULL
       ORDER BY topic`,
  );

  const listTopicsWithRows = (): string[] => {
    const rows = listTopicsWithRowsStmt.all() as { topic: string }[];
    return rows.map((r) => r.topic);
  };

  // D-136 §A.9 P5 — chain-head filter. The reconciler harness consumes
  // this for "the freshest meta snapshot per source" — which under
  // historical chains is the chain head, not arbitrary chain rows.
  const listByTargetStmt = db.prepare(
    `SELECT * FROM ${ENRICHMENT_TABLE}
       WHERE scope = ? AND target_id = ? AND superseded_by_id IS NULL
       ORDER BY ingested_at DESC
       LIMIT ?`,
  );

  const refreshMetaStmt = db.prepare(
    `UPDATE ${ENRICHMENT_TABLE}
       SET meta = ?
       WHERE scope = ? AND target_id = ?`,
  );

  const listByTarget = (
    scope: EnrichmentScope,
    target_id: string,
    opts: {
      limit?: number;
      axis?: 'event' | 'ingestion';
      since?: number;
      until?: number;
    } = {},
  ): EnrichmentRecord[] => {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    // Default 'ingestion' preserves the reconciler shape — every D-128
    // P1/P2/P3 caller threads no axis and gets ingested_at DESC via
    // the cached prepared statement.
    if ((opts.axis ?? 'ingestion') === 'ingestion'
        && opts.since === undefined
        && opts.until === undefined) {
      const rows = listByTargetStmt.all(scope, target_id, limit) as Record<
        string,
        unknown
      >[];
      return rows.map(rowToRecord);
    }
    // Event-axis OR explicit since/until — compose dynamic SQL. Cost
    // per call is one extra prepare; reusing the cached path for the
    // common reconciler shape above keeps the hot path fast.
    const tsExpr =
      (opts.axis ?? 'ingestion') === 'event'
        ? 'COALESCE(event_at, ingested_at)'
        : 'ingested_at';
    let sql = `SELECT * FROM ${ENRICHMENT_TABLE}
                  WHERE scope = ? AND target_id = ? AND superseded_by_id IS NULL`;
    const params: unknown[] = [scope, target_id];
    if (opts.since !== undefined) {
      sql += ` AND ${tsExpr} >= ?`;
      params.push(opts.since);
    }
    if (opts.until !== undefined) {
      sql += ` AND ${tsExpr} < ?`;
      params.push(opts.until);
    }
    sql += ` ORDER BY ${tsExpr} DESC LIMIT ?`;
    params.push(limit);
    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  };

  const refreshMetaForTarget = (
    scope: EnrichmentScope,
    target_id: string,
    new_meta: EnrichmentMeta,
  ): number => {
    // Throws `MetaSnapshotTooLargeError` on overflow — propagates to
    // the reconciler so cycle telemetry surfaces the offending vendor.
    const serialized = serializeEnrichmentMeta(new_meta);
    const out = refreshMetaStmt.run(serialized, scope, target_id);
    return out.changes;
  };

  // D-137 P2 § A.4 — distinct platform-reference target enumeration
  // for chat scope-search fan-out. Picks the latest chain-head row
  // per `(scope, target_id)` whose `meta` column is non-NULL. The
  // `MAX(rowid)` projection picks one canonical row per group — meta
  // is refreshed uniformly across the (scope, target_id) row set by
  // `refreshMetaForTarget` so any row's meta is equivalent.
  //
  // SCOPE_META_DEFAULT_LIMIT / SCOPE_META_MAX_LIMIT bound the chat
  // surface (clamped further to per-tool limits at the handler layer).
  const SCOPE_META_DEFAULT_LIMIT = 50;
  const SCOPE_META_MAX_LIMIT = 200;
  const listScopeMeta = (
    scope: EnrichmentScope,
    opts: {
      name_contains?: string;
      email_exact?: string;
      meta_equals?: ReadonlyArray<{ path: string; value: string }>;
      meta_ranges?: ReadonlyArray<{ path: string; min?: number; max?: number }>;
      limit?: number;
    } = {},
  ): Array<{ scope: EnrichmentScope; target_id: string; meta: EnrichmentMeta }> => {
    const limit = Math.min(
      Math.max(opts.limit ?? SCOPE_META_DEFAULT_LIMIT, 1),
      SCOPE_META_MAX_LIMIT,
    );
    // D-137 P2 Codex P2 fold — exclude rows the cascade engine has
    // flagged stale / expired. The reconciler's `markStaleForSource`
    // path (and D-136 P5b lifecycle-action queue) flip `staleness_class`
    // away from `'fresh'` on source change without rewriting `meta`
    // immediately; surfacing those rows to chat would let the agent
    // reference outdated CRM names / stages / owners until recompute
    // catches up. Mirrors the `EnrichmentListQuery.fresh_only` default
    // (which is `true` for every other read path).
    const where: string[] = [
      'scope = ?',
      'target_id IS NOT NULL',
      'meta IS NOT NULL',
      'superseded_by_id IS NULL',
      "staleness_class = 'fresh'",
    ];
    const args: unknown[] = [scope];
    if (opts.name_contains !== undefined && opts.name_contains.length > 0) {
      where.push("LOWER(json_extract(meta, '$.name')) LIKE ?");
      args.push(`%${opts.name_contains.toLowerCase()}%`);
    }
    if (opts.email_exact !== undefined && opts.email_exact.length > 0) {
      where.push("LOWER(json_extract(meta, '$.email')) = ?");
      args.push(opts.email_exact.toLowerCase());
    }
    // D-190 deal.search union slice — closed canonical-field filters over the
    // materialized mirror meta. The json path binds as a PARAMETER (so an
    // unexpected caller path can never splice into SQL); a row whose meta lacks
    // the key yields json_extract → NULL and drops on the comparison.
    for (const { path, value } of opts.meta_equals ?? []) {
      where.push('json_extract(meta, ?) = ?');
      args.push(path, value);
    }
    for (const { path, min, max } of opts.meta_ranges ?? []) {
      if (typeof min === 'number' && Number.isFinite(min)) {
        where.push('json_extract(meta, ?) >= ?');
        args.push(path, min);
      }
      if (typeof max === 'number' && Number.isFinite(max)) {
        where.push('json_extract(meta, ?) <= ?');
        args.push(path, max);
      }
    }
    // GROUP BY target_id picks one canonical row per target; ORDER BY
    // MAX(ingested_at) DESC surfaces the most recently refreshed
    // target first. The MAX(...) projections need GROUP BY-friendly
    // expressions — pull `meta` via the row with MAX(rowid) (well-
    // formed under SQLite's bare-column-in-GROUP-BY semantics; the
    // refreshMetaForTarget invariant guarantees any row's meta in
    // the group is equivalent).
    const sql = `SELECT target_id,
                        meta,
                        MAX(ingested_at) AS latest_ingested
                  FROM ${ENRICHMENT_TABLE}
                 WHERE ${where.join(' AND ')}
              GROUP BY target_id
              ORDER BY latest_ingested DESC
                 LIMIT ?`;
    args.push(limit);
    const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
    const out: Array<{
      scope: EnrichmentScope;
      target_id: string;
      meta: EnrichmentMeta;
    }> = [];
    for (const row of rows) {
      const target_id = row['target_id'];
      const rawMeta = row['meta'];
      if (typeof target_id !== 'string') continue;
      if (typeof rawMeta !== 'string') continue;
      const meta = deserializeEnrichmentMeta(rawMeta);
      if (meta === null) continue;
      out.push({ scope, target_id, meta });
    }
    return out;
  };

  const deleteById = (id: string): boolean => {
    const out = deleteByIdStmt.run(id);
    return out.changes > 0;
  };

  const deleteForSource = (scope: EnrichmentScope, target_id: string): number => {
    const out = deleteForSourceStmt.run(scope, target_id);
    return out.changes;
  };

  // D-192 — per-connection cut within a vendor-shared scope (`target_id LIKE
  // '<prefix>%' ESCAPE '\'`). Sidecars (vector_index / fts / votes) drop via
  // their ON DELETE CASCADE FK, so the plain row delete is complete.
  const deleteForScopeAndTargetPrefixStmt = db.prepare(
    `DELETE FROM ${ENRICHMENT_TABLE} WHERE scope = ? AND target_id LIKE ? ESCAPE '\\'`,
  );
  const deleteForScopeAndTargetPrefix = (
    scope: EnrichmentScope,
    target_id_prefix: string,
  ): number =>
    deleteForScopeAndTargetPrefixStmt.run(scope, `${escapeLikeWildcards(target_id_prefix)}%`).changes;

  const listChainHeadRowIdsByScopeAndTargetPrefixStmt = db.prepare(
    `SELECT _id FROM ${ENRICHMENT_TABLE}
       WHERE superseded_by_id IS NULL AND scope = ? AND target_id LIKE ? ESCAPE '\\'`,
  );
  const listChainHeadRowIdsByScopeAndTargetPrefix = (
    scope: EnrichmentScope,
    target_id_prefix: string,
  ): string[] =>
    (
      listChainHeadRowIdsByScopeAndTargetPrefixStmt.all(
        scope,
        `${escapeLikeWildcards(target_id_prefix)}%`,
      ) as Array<{ _id: string }>
    ).map((r) => r._id);

  const markStaleByAuthor = (authored_by: string): number => {
    const out = markStaleByAuthorStmt.run(authored_by);
    if (out.changes > 0) {
      // Drop sidecars on every newly-stale row. Two index-narrow
      // deletes; cheap relative to the recipe-upgrade path that
      // triggered this.
      db.exec(`DELETE FROM ${VECTOR_INDEX_TABLE}
                 WHERE enrichment_id IN (
                   SELECT _id FROM ${ENRICHMENT_TABLE}
                   WHERE authored_by = ${quote(authored_by)}
                     AND staleness_class != 'fresh'
                 )`);
      db.exec(`DELETE FROM ${FTS_TABLE}
                 WHERE enrichment_id IN (
                   SELECT _id FROM ${ENRICHMENT_TABLE}
                   WHERE authored_by = ${quote(authored_by)}
                     AND staleness_class != 'fresh'
                 )`);
    }
    return out.changes;
  };

  const markStaleForSource = (scope: EnrichmentScope, target_id: string): number => {
    const out = markStaleForSourceStmt.run(scope, target_id);
    if (out.changes > 0) {
      db.exec(`DELETE FROM ${VECTOR_INDEX_TABLE}
                 WHERE enrichment_id IN (
                   SELECT _id FROM ${ENRICHMENT_TABLE}
                   WHERE scope = ${quote(scope)}
                     AND target_id = ${quote(target_id)}
                     AND staleness_class != 'fresh'
                 )`);
      db.exec(`DELETE FROM ${FTS_TABLE}
                 WHERE enrichment_id IN (
                   SELECT _id FROM ${ENRICHMENT_TABLE}
                   WHERE scope = ${quote(scope)}
                     AND target_id = ${quote(target_id)}
                     AND staleness_class != 'fresh'
                 )`);
    }
    return out.changes;
  };

  const trimMember = (topic: string, member_id: string): { trimmed: number; deleted: number } => {
    if (!isEnrichmentTopic(topic)) return { trimmed: 0, deleted: 0 };
    const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
    if (def.policy !== 'members_list') return { trimmed: 0, deleted: 0 };
    const field = def.members_field ?? 'members';

    // List every row of the topic, parse value in JS, narrow to those
    // carrying member_id. Registry-bounded list size makes the JS-side
    // walk fine; would only be worth a SQL filter for cluster topics
    // with > tens of thousands of rows, at which point D-124 will ship
    // a faster path.
    //
    // P6 / Codex review — `value IS NOT NULL` excludes tombstoned rows
    // (P6 NULLs the value column on tombstone) so `JSON.parse(null)`
    // doesn't blow up the trim path on a subsequent source-delete
    // cascade. The tombstoned row stays in place (D-120 link graph
    // contract) but contributes nothing to membership.
    const rows = db.prepare(
      `SELECT _id, value FROM ${ENRICHMENT_TABLE}
        WHERE topic = ? AND value IS NOT NULL`,
    ).all(topic) as Array<{ _id: string; value: string }>;

    let trimmed = 0;
    let deleted = 0;
    const updateValueStmt = db.prepare(
      `UPDATE ${ENRICHMENT_TABLE} SET value = ?, ingested_at = ? WHERE _id = ?`,
    );
    const ts = now();
    for (const row of rows) {
      let parsed: Record<string, unknown>;
      try {
        const v = JSON.parse(row.value) as Record<string, unknown>;
        parsed = v;
      } catch {
        continue;
      }
      const arr = parsed[field];
      if (!Array.isArray(arr)) continue;
      if (!arr.includes(member_id)) continue;
      const next = arr.filter((m) => m !== member_id);
      if (next.length === 0) {
        deleteByIdStmt.run(row._id);
        deleted += 1;
      } else {
        parsed[field] = next;
        updateValueStmt.run(JSON.stringify(parsed), ts, row._id);
        trimmed += 1;
      }
    }
    return { trimmed, deleted };
  };

  const reset = (topic: string): number => {
    if (!isEnrichmentTopic(topic)) return 0;
    return resetStmt.run(topic).changes;
  };

  // D-136 P4 / §A.5 P5b — flip every chain-head, non-pinned, NULL-pending
  // row of the topic to staleness_class='stale' + LAP=action + drop
  // sidecars on the same row set. Pre-P5b version only set LAP — Codex
  // P5b review flagged this as a silent-loss bug because the
  // per-producer harness's stale-sweep filters `staleness_class !=
  // 'fresh'` and would skip the queued rows. Implementation pattern
  // matches `markStaleAndEnqueueByRowIds`: pre-collect affected ids so
  // sidecar deletes + the main UPDATE target the same set.
  const selectTopicEnqueueCandidatesStmt = db.prepare(
    `SELECT _id FROM ${ENRICHMENT_TABLE}
       WHERE topic = ?
         AND lifecycle_action_pending IS NULL
         AND superseded_by_id IS NULL
         AND is_pinned = 0`,
  );
  const countTopicEnqueueCandidatesStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ${ENRICHMENT_TABLE}
       WHERE topic = ?
         AND lifecycle_action_pending IS NULL
         AND superseded_by_id IS NULL
         AND is_pinned = 0`,
  );
  const enqueueLifecycleActionForTopic = (
    topic: string,
    action: LifecycleActionPending,
  ): number => {
    if (!isEnrichmentTopic(topic)) return 0;
    const candidates = selectTopicEnqueueCandidatesStmt.all(topic) as Array<{
      _id: string;
    }>;
    if (candidates.length === 0) return 0;
    const ids = candidates.map((r) => r._id);
    let changed = 0;
    for (const chunk of chunkRowIds(ids)) {
      const placeholders = chunk.map(() => '?').join(',');
      // Drop sidecars first — same shape as `markStaleAndEnqueueByRowIds`.
      // The pre-collected id set is already filtered to non-pinned +
      // NULL-pending, so we don't risk dropping a pinned row's sidecar.
      db.prepare(
        `DELETE FROM ${VECTOR_INDEX_TABLE}
           WHERE enrichment_id IN (${placeholders})`,
      ).run(...chunk);
      db.prepare(
        `DELETE FROM ${FTS_TABLE}
           WHERE enrichment_id IN (${placeholders})`,
      ).run(...chunk);
      const res = db
        .prepare(
          `UPDATE ${ENRICHMENT_TABLE}
             SET staleness_class = 'stale', lifecycle_action_pending = ?
             WHERE _id IN (${placeholders})`,
        )
        .run(action, ...chunk);
      changed += res.changes;
    }
    return changed;
  };
  const countTopicEnqueueCandidates = (topic: string): number => {
    if (!isEnrichmentTopic(topic)) return 0;
    return (countTopicEnqueueCandidatesStmt.get(topic) as { n: number }).n;
  };

  // D-136 §A.7 P5b — read-side companion to `enqueueLifecycleAction*`.
  // Surfaces every chain-head row whose lifecycle action is pending so
  // the walk-cap planner can build its CyclePlan. The same chain-head
  // + non-pinned filter the write path uses applies here so the
  // planner's worldview matches what's actually queueable.
  const listLifecycleActionPendingAllStmt = db.prepare(
    `SELECT * FROM ${ENRICHMENT_TABLE}
       WHERE lifecycle_action_pending IS NOT NULL
         AND superseded_by_id IS NULL
         AND is_pinned = 0
       ORDER BY topic ASC, target_id ASC, _id ASC`,
  );
  const listLifecycleActionPending = (opts?: {
    topic_in?: ReadonlyArray<string>;
    limit?: number;
  }): EnrichmentRecord[] => {
    const topicFilter = opts?.topic_in;
    const limit = opts?.limit;
    let rows: Array<Record<string, unknown>>;
    if (topicFilter && topicFilter.length > 0) {
      const placeholders = topicFilter.map(() => '?').join(',');
      const sql =
        `SELECT * FROM ${ENRICHMENT_TABLE}
           WHERE lifecycle_action_pending IS NOT NULL
             AND superseded_by_id IS NULL
             AND is_pinned = 0
             AND topic IN (${placeholders})
           ORDER BY topic ASC, target_id ASC, _id ASC` +
        (limit !== undefined ? ' LIMIT ?' : '');
      const params: unknown[] = [...topicFilter];
      if (limit !== undefined) params.push(limit);
      rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    } else if (limit !== undefined) {
      const sql =
        `SELECT * FROM ${ENRICHMENT_TABLE}
           WHERE lifecycle_action_pending IS NOT NULL
             AND superseded_by_id IS NULL
             AND is_pinned = 0
           ORDER BY topic ASC, target_id ASC, _id ASC
           LIMIT ?`;
      rows = db.prepare(sql).all(limit) as Array<Record<string, unknown>>;
    } else {
      rows = listLifecycleActionPendingAllStmt.all() as Array<Record<string, unknown>>;
    }
    return rows.map(rowToRecord);
  };

  // D-136 §A.5 / §A.7 P5b — per-topic queue depth used by the cascade
  // fan-out budget gate (cascade_queue_depth_max_per_topic).
  const countLifecycleActionPendingByTopicStmt = db.prepare(
    `SELECT topic, COUNT(*) AS n FROM ${ENRICHMENT_TABLE}
       WHERE lifecycle_action_pending IS NOT NULL
         AND superseded_by_id IS NULL
         AND is_pinned = 0
       GROUP BY topic`,
  );
  const countLifecycleActionPendingByTopic = (): ReadonlyArray<{
    topic: string;
    count: number;
  }> => {
    const rows = countLifecycleActionPendingByTopicStmt.all() as Array<{
      topic: string;
      n: number;
    }>;
    return rows.map((r) => ({ topic: r.topic, count: r.n }));
  };

  const count = (): number => (countStmt.get() as { n: number }).n;
  const countForTopic = (topic: string): number =>
    (countForTopicStmt.get(topic) as { n: number }).n;

  // D-136 §A.13.1 P7.D — latest effective time per topic. Uses the same
  // `COALESCE(event_at, ingested_at)` expression the timeline + chain
  // resolvers use, so all three surfaces agree on "what time is this row".
  const latestEventAtForTopicStmt = db.prepare(
    `SELECT MAX(COALESCE(event_at, ingested_at)) AS ts
       FROM ${ENRICHMENT_TABLE}
      WHERE topic = ?`,
  );
  const getLatestEventAtForTopic = (topic: string): number | null => {
    const row = latestEventAtForTopicStmt.get(topic) as { ts: number | null };
    return row.ts ?? null;
  };

  // ── D-136 §A.5 P5 cascade-primitive store hooks ─────────────────
  //
  // The cascade engine (`enrichment-cascade.ts`) drives these
  // operations after walking the registry to identify candidate
  // rows. The store's job is the SQL: list affected rows, mark them
  // stale + enqueue, or tombstone. Every mutation skips pinned rows
  // (`is_pinned = 1`) and treats already-pending rows as no-ops.

  const listConsumerRowIdsOfUpstreamStmt = db.prepare(
    `SELECT _id FROM ${ENRICHMENT_TABLE}
       WHERE input_enrichment_row_ids IS NOT NULL
         AND superseded_by_id IS NULL
         AND EXISTS (
           SELECT 1 FROM json_each(${ENRICHMENT_TABLE}.input_enrichment_row_ids) je
            WHERE je.value = ?
         )`,
  );
  const listConsumerRowIdsOfUpstream = (upstream_row_id: string): string[] => {
    const rows = listConsumerRowIdsOfUpstreamStmt.all(upstream_row_id) as Array<{ _id: string }>;
    return rows.map((r) => r._id);
  };

  const listChainHeadRowIdsByTopicAndTargets = (
    topic: string,
    target_ids: ReadonlyArray<string>,
  ): string[] => {
    if (target_ids.length === 0) return [];
    const placeholders = target_ids.map(() => '?').join(',');
    const sql =
      `SELECT _id FROM ${ENRICHMENT_TABLE}
         WHERE topic = ?
           AND target_id IN (${placeholders})
           AND superseded_by_id IS NULL`;
    const rows = db.prepare(sql).all(topic, ...target_ids) as Array<{ _id: string }>;
    return rows.map((r) => r._id);
  };

  const listChainHeadRowIdsByProducerVersionStmt = db.prepare(
    `SELECT _id FROM ${ENRICHMENT_TABLE}
       WHERE producer_version_hash = ? AND superseded_by_id IS NULL`,
  );
  const listChainHeadRowIdsByProducerVersion = (old_version_hash: string): string[] => {
    const rows = listChainHeadRowIdsByProducerVersionStmt.all(old_version_hash) as Array<{
      _id: string;
    }>;
    return rows.map((r) => r._id);
  };

  const listChainHeadRowIdsByScopeAndTargetStmt = db.prepare(
    `SELECT _id FROM ${ENRICHMENT_TABLE}
       WHERE scope = ? AND target_id = ? AND superseded_by_id IS NULL`,
  );
  const listChainHeadRowIdsByScopeAndTarget = (scope: string, target_id: string): string[] => {
    const rows = listChainHeadRowIdsByScopeAndTargetStmt.all(scope, target_id) as Array<{
      _id: string;
    }>;
    return rows.map((r) => r._id);
  };

  const listChainHeadRowIdsByScopeAndTargetPattern = (args: {
    scopePrefixDot?: string;
    scopeEquals?: string;
    targetIdLikePattern?: string;
  }): string[] => {
    const where: string[] = ['superseded_by_id IS NULL'];
    const params: string[] = [];
    if (args.scopeEquals !== undefined) {
      where.push('scope = ?');
      params.push(args.scopeEquals);
    } else if (args.scopePrefixDot !== undefined) {
      where.push("(scope = ? OR scope LIKE ?)");
      params.push(args.scopePrefixDot);
      params.push(`${args.scopePrefixDot}.%`);
    } else {
      // No scope filter → caller error; refuse to scan the entire
      // table by accident. Returning empty also keeps the cascade
      // primitives hermetic against a misconfigured registry walk.
      return [];
    }
    if (args.targetIdLikePattern !== undefined) {
      where.push('target_id LIKE ?');
      params.push(args.targetIdLikePattern);
    }
    const sql = `SELECT _id FROM ${ENRICHMENT_TABLE} WHERE ${where.join(' AND ')}`;
    const rows = db.prepare(sql).all(...params) as Array<{ _id: string }>;
    return rows.map((r) => r._id);
  };

  // The dynamic IN list keeps the SQL flat. SQLite caps parameters at
  // 32766 in modern builds — production cascade fan-out is well below
  // that, but we still chunk defensively at 500 ids per call.
  const ROW_IDS_CHUNK = 500;
  const chunkRowIds = <T extends string>(ids: ReadonlyArray<T>): T[][] => {
    if (ids.length <= ROW_IDS_CHUNK) return ids.length > 0 ? [ids as T[]] : [];
    const out: T[][] = [];
    for (let i = 0; i < ids.length; i += ROW_IDS_CHUNK) {
      out.push(ids.slice(i, i + ROW_IDS_CHUNK) as T[]);
    }
    return out;
  };

  const markStaleAndEnqueueByRowIds = (
    row_ids: ReadonlyArray<string>,
    action: LifecycleActionPending,
  ): number => {
    if (row_ids.length === 0) return 0;
    let changed = 0;
    for (const chunk of chunkRowIds(row_ids)) {
      const placeholders = chunk.map(() => '?').join(',');
      // Pre-collect the affected ids so sidecar deletes + the main
      // UPDATE target the same set. Pinned + already-pending rows are
      // filtered out at this step; the cascade-stale path then matches
      // `markStaleByAuthor` / `markStaleForSource` discipline by
      // dropping sidecars synchronously so vector / FTS searches
      // don't surface stale content while the producer reruns.
      const affectedRows = db
        .prepare(
          `SELECT _id FROM ${ENRICHMENT_TABLE}
             WHERE _id IN (${placeholders})
               AND is_pinned = 0
               AND lifecycle_action_pending IS NULL`,
        )
        .all(...chunk) as Array<{ _id: string }>;
      if (affectedRows.length === 0) continue;
      const affectedIds = affectedRows.map((r) => r._id);
      const affectedPlaceholders = affectedIds.map(() => '?').join(',');
      // Drop sidecars first (idempotent — the FK CASCADE on row delete
      // would handle this too, but the row stays; only sidecars go).
      db.prepare(
        `DELETE FROM ${VECTOR_INDEX_TABLE}
           WHERE enrichment_id IN (${affectedPlaceholders})`,
      ).run(...affectedIds);
      db.prepare(
        `DELETE FROM ${FTS_TABLE}
           WHERE enrichment_id IN (${affectedPlaceholders})`,
      ).run(...affectedIds);
      const res = db
        .prepare(
          `UPDATE ${ENRICHMENT_TABLE}
             SET staleness_class = 'stale', lifecycle_action_pending = ?
             WHERE _id IN (${affectedPlaceholders})`,
        )
        .run(action, ...affectedIds);
      changed += res.changes;
    }
    return changed;
  };

  // ── §A.6 P6 / Codex review — eligible stale-row sweep ──────────
  //
  // Filters at SQL level to avoid stale-sweep starvation: a batch of
  // ineligible (retry-armed-future, permanently_failed, discard,
  // tombstoned, pinned, superseded) rows ahead of older eligible work
  // would otherwise spin every cycle without making progress. The
  // retry-at parse strips the `retry_at_` prefix + casts to integer
  // for comparison against the caller-supplied `now`.
  //
  // §A.12 P7.B Codex review #2 — tombstoned rows are eligible when
  // `lifecycle_action_pending = 'recompute'`. This is the topic-reset
  // path: confirm tombstones the chain head + sets LAP=recompute
  // expecting the next cycle to re-derive. Without the override, the
  // row would stay tombstoned + LAP=recompute forever (drain only
  // observes 'discard'; producer cursor walks may dedup-hit the cached
  // hashes and skip). Cascade-driven tombstones (source_revoked /
  // ttl_expired / cascade_delete / user_discarded via vote.delete)
  // never set LAP=recompute, so they stay filtered out.
  const listStaleRowsForReDeriveStmt = db.prepare(
    `SELECT * FROM ${ENRICHMENT_TABLE}
       WHERE topic = ?
         AND scope = ?
         AND authored_by = ?
         AND staleness_class != 'fresh'
         AND superseded_by_id IS NULL
         AND (tombstoned_at IS NULL OR lifecycle_action_pending = 'recompute')
         AND is_pinned = 0
         AND (
           lifecycle_action_pending IS NULL
           OR lifecycle_action_pending = 'recompute'
           OR (
             lifecycle_action_pending LIKE 'retry_at_%'
             AND CAST(SUBSTR(lifecycle_action_pending, 10) AS INTEGER) <= ?
           )
         )
       ORDER BY ingested_at ASC
       LIMIT ?`,
  );
  const listStaleRowsForReDerive = (args: {
    topic: string;
    scope: EnrichmentScope;
    authored_by: string;
    now: number;
    limit: number;
  }): EnrichmentRecord[] => {
    const rows = listStaleRowsForReDeriveStmt.all(
      args.topic,
      args.scope,
      args.authored_by,
      args.now,
      args.limit,
    ) as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  };

  const tombstoneRowIds = (
    row_ids: ReadonlyArray<string>,
    reason: 'cascade_delete' | 'source_revoked' | 'ttl_expired' | 'user_discarded',
  ): number => {
    if (row_ids.length === 0) return 0;
    const ts = now();
    let changed = 0;
    for (const chunk of chunkRowIds(row_ids)) {
      const placeholders = chunk.map(() => '?').join(',');
      // P6 — tombstone-with-id (audit §10.2). NULL the `value` column
      // so consumers reading the row no longer see the formerly-cached
      // payload while preserving `_id` + `event_at` for the D-120 link
      // graph. Also NULL the platform-reference `meta` snapshot — the
      // reconciler walks `data_enrichment` by `meta IS NOT NULL` to
      // pick up the freshest record state, and CRM producers
      // (attribution_signal / lifecycle_stage_inferred / etc.) read
      // the same shape; without this clear, a deleted connection's
      // stale meta would resurrect rows on the next producer cycle.
      // Drops sidecars synchronously so vector / FTS searches don't
      // surface tombstoned content. P5b also cleared LAP — kept here
      // so the drain consumer's next pass doesn't re-surface tombstoned
      // rows in `listLifecycleActionPending`.
      const affectedRows = db
        .prepare(
          `SELECT _id FROM ${ENRICHMENT_TABLE}
             WHERE _id IN (${placeholders})
               AND is_pinned = 0
               AND tombstoned_at IS NULL`,
        )
        .all(...chunk) as Array<{ _id: string }>;
      if (affectedRows.length === 0) continue;
      const affectedIds = affectedRows.map((r) => r._id);
      const affectedPlaceholders = affectedIds.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM ${VECTOR_INDEX_TABLE}
           WHERE enrichment_id IN (${affectedPlaceholders})`,
      ).run(...affectedIds);
      db.prepare(
        `DELETE FROM ${FTS_TABLE}
           WHERE enrichment_id IN (${affectedPlaceholders})`,
      ).run(...affectedIds);
      const res = db
        .prepare(
          `UPDATE ${ENRICHMENT_TABLE}
             SET value = NULL,
                 meta = NULL,
                 tombstoned_at = ?, tombstone_reason = ?,
                 staleness_class = 'expired', lifecycle_action_pending = NULL
             WHERE _id IN (${affectedPlaceholders})`,
        )
        .run(ts, reason, ...affectedIds);
      changed += res.changes;
    }
    return changed;
  };

  // ── §A.6 / audit §9 P6 — producer failure recording ─────────────
  //
  // Splits between INSERT (no row exists for the triple yet — first
  // attempt against a new source record fails) and UPDATE (a prior
  // run wrote a row that's now retrying after backoff or escalating
  // to permanently_failed). The placeholder INSERT path holds value
  // NULL + staleness_class = 'stale' so the harness's stale-sweep
  // sees it on the next cycle and re-runs the producer. Subsequent
  // successful upsert via the existing update statements clears
  // `failure_attempt_count` + `last_failure_reason` + LAP (P5b
  // upsert-side substrate change).

  const findRowIdForFailureStmt = db.prepare(
    `SELECT _id, failure_attempt_count
       FROM ${ENRICHMENT_TABLE}
       WHERE topic = ? AND scope = ? AND target_id = ? AND authored_by = ?
         AND superseded_by_id IS NULL`,
  );

  const insertFailurePlaceholderStmt = db.prepare(
    `INSERT INTO ${ENRICHMENT_TABLE}
       (_id, topic, scope, target_id, derived_entity_id, value, authored_by,
        source_record_hash, recipe_hash, ingredient_slug, model_id, event_at,
        ingested_at, authored_at, as_of, last_evaluated_at,
        producer_version_hash, input_fingerprint_hash, input_completeness,
        input_enrichment_row_ids, staleness_class, lifecycle_action_pending,
        failure_attempt_count, last_failure_reason,
        is_pinned, meta, mirror_blob_hash)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL,
               ?, ?, NULL, ?, NULL, ?, NULL,
               NULL, 'stale', ?, 1, ?, 0, NULL, NULL)`,
  );

  const updateFailureStmt = db.prepare(
    `UPDATE ${ENRICHMENT_TABLE}
       SET failure_attempt_count = ?,
           last_failure_reason = ?,
           lifecycle_action_pending = ?,
           staleness_class = ?,
           last_evaluated_at = ?
       WHERE _id = ?`,
  );

  const recordProducerFailure = (args: {
    topic: string;
    scope: EnrichmentScope;
    target_id: string;
    authored_by: string;
    reason: string;
    source_record_hash?: string;
    now?: number;
  }): { row_id: string; attempt_count: number; lifecycle_action: string } => {
    const ts = args.now ?? now();
    const existing = findRowIdForFailureStmt.get(
      args.topic,
      args.scope,
      args.target_id,
      args.authored_by,
    ) as { _id: string; failure_attempt_count: number } | undefined;
    const priorCount = existing?.failure_attempt_count ?? 0;
    const newCount = priorCount + 1;
    let action: string;
    let stalenessClass: 'stale' | 'expired';
    if (newCount > RETRY_BACKOFFS_MS.length) {
      action = 'permanently_failed';
      // Permanently-failed rows are conceptually expired — the cascade
      // engine + drain treat them like tombstones for visibility while
      // the underlying value (if any) stays on the row for the
      // D-120 link graph. Tombstone-with-id semantics apply at the
      // next explicit cleanup step.
      stalenessClass = 'expired';
    } else {
      const wakeAt = ts + RETRY_BACKOFFS_MS[newCount - 1]!;
      action = composeRetryAtToken(wakeAt);
      stalenessClass = 'stale';
    }
    if (existing) {
      updateFailureStmt.run(
        newCount,
        args.reason,
        action,
        stalenessClass,
        ts,
        existing._id,
      );
      return { row_id: existing._id, attempt_count: newCount, lifecycle_action: action };
    }
    const id = newId();
    insertFailurePlaceholderStmt.run(
      id,
      args.topic,
      args.scope,
      args.target_id,
      args.authored_by,
      args.source_record_hash ?? null,
      ts, // ingested_at
      ts, // authored_at
      ts, // last_evaluated_at
      args.source_record_hash ?? null, // input_fingerprint_hash (degenerate per-record default)
      action,
      args.reason,
    );
    return { row_id: id, attempt_count: newCount, lifecycle_action: action };
  };

  // ── D-136 §A.11 P7 — quality-vote substrate ────────────────────
  //
  // Vote consumer routing. The store records the vote + the routing
  // decision in one transaction so the audit trail captures both
  // (the routing column is the recorded outcome — what the system
  // actually did with the vote).

  const getByIdStmt = db.prepare(`SELECT * FROM ${ENRICHMENT_TABLE} WHERE _id = ?`);
  const getById = (id: string): EnrichmentRecord | null => {
    const row = getByIdStmt.get(id) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  };

  // ── D-136 §A.13.3 P7.C — historical-chain resolver ──────────────
  //
  // Walks the supersede chain for `(topic, scope, target_id)` (Shape A)
  // or `(topic, derived_entity_id)` (Shape B). Effective time is
  // `COALESCE(event_at, ingested_at)` so legacy rows without `event_at`
  // still land on the timeline.
  //
  // Each row's coverage interval is `[effective_time, successor_effective_time)`,
  // where `successor_effective_time` is derived from the supersede link
  // (the row whose `_id = current.superseded_by_id`). Chain heads
  // (`superseded_by_id IS NULL`) have no successor and their interval
  // extends to `+∞`. The interval is left-closed / right-open: as_of=T
  // matches the row whose effective_time = T, not its predecessor.
  //
  // The interval-via-supersede-link gate (the second `> ?` placeholder
  // in each WHERE clause) is load-bearing — without it, a non-monotonic
  // chain (backfill writes a newer head with an older event_at, or two
  // chain rows share the same effective_time) would let an ancestor row
  // win the `ORDER BY ... DESC LIMIT 1` tie even when its interval is
  // empty (event_at >= successor.event_at) and the head's `[head.event_at,
  // +∞)` is the correct cover. Codex P7.C review caught this regression.
  //
  // Multi-author shape A: each author chain has its own supersede link
  // graph, so the interval gate evaluates per-row independently. Without
  // `authored_by`, the freshest covering row across all chains wins
  // (matches the resolver's "latest ingested when multiple authors exist"
  // convention). Tombstoned rows surface as-is per audit §10.2.

  const getRowAsOfShapeAWithAuthorStmt = db.prepare(
    `SELECT e.* FROM ${ENRICHMENT_TABLE} e
       WHERE e.topic = ? AND e.scope = ? AND e.target_id = ?
         AND e.authored_by = ?
         AND COALESCE(e.event_at, e.ingested_at) <= ?
         AND (
           e.superseded_by_id IS NULL
           OR (SELECT COALESCE(s.event_at, s.ingested_at)
                 FROM ${ENRICHMENT_TABLE} s WHERE s._id = e.superseded_by_id) > ?
         )
       ORDER BY COALESCE(e.event_at, e.ingested_at) DESC, e.ingested_at DESC
       LIMIT 1`,
  );
  const getRowAsOfShapeAStmt = db.prepare(
    `SELECT e.* FROM ${ENRICHMENT_TABLE} e
       WHERE e.topic = ? AND e.scope = ? AND e.target_id = ?
         AND COALESCE(e.event_at, e.ingested_at) <= ?
         AND (
           e.superseded_by_id IS NULL
           OR (SELECT COALESCE(s.event_at, s.ingested_at)
                 FROM ${ENRICHMENT_TABLE} s WHERE s._id = e.superseded_by_id) > ?
         )
       ORDER BY COALESCE(e.event_at, e.ingested_at) DESC, e.ingested_at DESC
       LIMIT 1`,
  );
  const getRowAsOfShapeBStmt = db.prepare(
    `SELECT e.* FROM ${ENRICHMENT_TABLE} e
       WHERE e.topic = ? AND e.derived_entity_id = ? AND e.scope IS NULL
         AND COALESCE(e.event_at, e.ingested_at) <= ?
         AND (
           e.superseded_by_id IS NULL
           OR (SELECT COALESCE(s.event_at, s.ingested_at)
                 FROM ${ENRICHMENT_TABLE} s WHERE s._id = e.superseded_by_id) > ?
         )
       ORDER BY COALESCE(e.event_at, e.ingested_at) DESC, e.ingested_at DESC
       LIMIT 1`,
  );

  const getChainShapeAWithAuthorStmt = db.prepare(
    `SELECT * FROM ${ENRICHMENT_TABLE}
       WHERE topic = ? AND scope = ? AND target_id = ?
         AND authored_by = ?
       ORDER BY COALESCE(event_at, ingested_at) DESC, ingested_at DESC
       LIMIT ?`,
  );
  const getChainShapeAStmt = db.prepare(
    `SELECT * FROM ${ENRICHMENT_TABLE}
       WHERE topic = ? AND scope = ? AND target_id = ?
       ORDER BY COALESCE(event_at, ingested_at) DESC, ingested_at DESC
       LIMIT ?`,
  );
  const getChainShapeBStmt = db.prepare(
    `SELECT * FROM ${ENRICHMENT_TABLE}
       WHERE topic = ? AND derived_entity_id = ? AND scope IS NULL
       ORDER BY COALESCE(event_at, ingested_at) DESC, ingested_at DESC
       LIMIT ?`,
  );

  // D-136 P7.D Codex review fix — substrate-private (pinned) variants of
  // getRowAsOf + getChain. Filter `is_pinned = 0` AND `authored_by NOT
  // LIKE 'system.user_correction%'` so the MCP read surface never sees
  // pinned correction rows per spec §A.13.5. Both conditions are
  // applied (defense-in-depth — `is_pinned` is the schema flag set on
  // pinned writes, the LIKE-prefix check defends against rows whose
  // flag failed to set for any future bug). Prefix is a closed-list
  // constant from contracts so the literal interpolation isn't an
  // injection vector.
  const NOT_PINNED_CLAUSE = `AND e.is_pinned = 0 AND e.authored_by NOT LIKE '${ENRICHMENT_PINNED_AUTHOR_PREFIX}%'`;
  const NOT_PINNED_CLAUSE_BARE = `AND is_pinned = 0 AND authored_by NOT LIKE '${ENRICHMENT_PINNED_AUTHOR_PREFIX}%'`;

  const getRowAsOfShapeAWithAuthorExcludePinnedStmt = db.prepare(
    `SELECT e.* FROM ${ENRICHMENT_TABLE} e
       WHERE e.topic = ? AND e.scope = ? AND e.target_id = ?
         AND e.authored_by = ?
         AND COALESCE(e.event_at, e.ingested_at) <= ?
         AND (
           e.superseded_by_id IS NULL
           OR (SELECT COALESCE(s.event_at, s.ingested_at)
                 FROM ${ENRICHMENT_TABLE} s WHERE s._id = e.superseded_by_id) > ?
         )
         ${NOT_PINNED_CLAUSE}
       ORDER BY COALESCE(e.event_at, e.ingested_at) DESC, e.ingested_at DESC
       LIMIT 1`,
  );
  const getRowAsOfShapeAExcludePinnedStmt = db.prepare(
    `SELECT e.* FROM ${ENRICHMENT_TABLE} e
       WHERE e.topic = ? AND e.scope = ? AND e.target_id = ?
         AND COALESCE(e.event_at, e.ingested_at) <= ?
         AND (
           e.superseded_by_id IS NULL
           OR (SELECT COALESCE(s.event_at, s.ingested_at)
                 FROM ${ENRICHMENT_TABLE} s WHERE s._id = e.superseded_by_id) > ?
         )
         ${NOT_PINNED_CLAUSE}
       ORDER BY COALESCE(e.event_at, e.ingested_at) DESC, e.ingested_at DESC
       LIMIT 1`,
  );
  const getRowAsOfShapeBExcludePinnedStmt = db.prepare(
    `SELECT e.* FROM ${ENRICHMENT_TABLE} e
       WHERE e.topic = ? AND e.derived_entity_id = ? AND e.scope IS NULL
         AND COALESCE(e.event_at, e.ingested_at) <= ?
         AND (
           e.superseded_by_id IS NULL
           OR (SELECT COALESCE(s.event_at, s.ingested_at)
                 FROM ${ENRICHMENT_TABLE} s WHERE s._id = e.superseded_by_id) > ?
         )
         ${NOT_PINNED_CLAUSE}
       ORDER BY COALESCE(e.event_at, e.ingested_at) DESC, e.ingested_at DESC
       LIMIT 1`,
  );

  const getChainShapeAWithAuthorExcludePinnedStmt = db.prepare(
    `SELECT * FROM ${ENRICHMENT_TABLE}
       WHERE topic = ? AND scope = ? AND target_id = ?
         AND authored_by = ?
         ${NOT_PINNED_CLAUSE_BARE}
       ORDER BY COALESCE(event_at, ingested_at) DESC, ingested_at DESC
       LIMIT ?`,
  );
  const getChainShapeAExcludePinnedStmt = db.prepare(
    `SELECT * FROM ${ENRICHMENT_TABLE}
       WHERE topic = ? AND scope = ? AND target_id = ?
         ${NOT_PINNED_CLAUSE_BARE}
       ORDER BY COALESCE(event_at, ingested_at) DESC, ingested_at DESC
       LIMIT ?`,
  );
  const getChainShapeBExcludePinnedStmt = db.prepare(
    `SELECT * FROM ${ENRICHMENT_TABLE}
       WHERE topic = ? AND derived_entity_id = ? AND scope IS NULL
         ${NOT_PINNED_CLAUSE_BARE}
       ORDER BY COALESCE(event_at, ingested_at) DESC, ingested_at DESC
       LIMIT ?`,
  );

  const validateChainArgs = (args: {
    topic: string;
    scope?: EnrichmentScope;
    target_id?: string;
    derived_entity_id?: string;
  }): { def: EnrichmentDefinition; topicNarrow: EnrichmentTopic } => {
    if (!isEnrichmentTopic(args.topic)) {
      throw new EnrichmentTopicUnknownError(args.topic);
    }
    const topicNarrow = args.topic;
    const def = getEnrichmentDefinition(topicNarrow);
    if (def.shape === 'per_record') {
      if (typeof args.scope !== 'string' || typeof args.target_id !== 'string') {
        throw new EnrichmentShapeMismatchError(
          topicNarrow,
          'per_record topics require scope + target_id for chain walk',
        );
      }
      // D-192 S4b — must mirror the upsert gate: a pack scope written via the
      // widened `validate` must also be READABLE through the chain walk.
      if (!isScopeWritable(def, args.scope)) {
        throw new EnrichmentScopeUnsupportedError(topicNarrow, args.scope);
      }
      if (typeof args.derived_entity_id === 'string') {
        throw new EnrichmentShapeMismatchError(
          topicNarrow,
          'per_record chain walk does not accept derived_entity_id',
        );
      }
    } else {
      if (typeof args.derived_entity_id !== 'string') {
        throw new EnrichmentShapeMismatchError(
          topicNarrow,
          'derived_entity topics require derived_entity_id for chain walk',
        );
      }
      if (typeof args.scope === 'string' || typeof args.target_id === 'string') {
        throw new EnrichmentShapeMismatchError(
          topicNarrow,
          'derived_entity chain walk does not accept scope / target_id',
        );
      }
    }
    return { def, topicNarrow };
  };

  const getRowAsOf = (args: {
    topic: string;
    scope?: EnrichmentScope;
    target_id?: string;
    derived_entity_id?: string;
    authored_by?: string;
    as_of: number;
    exclude_pinned?: boolean;
  }): EnrichmentRecord | null => {
    if (typeof args.as_of !== 'number' || !Number.isFinite(args.as_of)) {
      return null;
    }
    const { def, topicNarrow } = validateChainArgs(args);
    const excludePinned = args.exclude_pinned === true;
    let row: Record<string, unknown> | undefined;
    // Each statement binds `as_of` twice: once for the lower-bound
    // gate (`effective_time <= as_of`) and once for the successor
    // upper-bound gate (`successor_effective_time > as_of`).
    if (def.shape === 'per_record') {
      if (typeof args.authored_by === 'string' && args.authored_by.length > 0) {
        const stmt = excludePinned
          ? getRowAsOfShapeAWithAuthorExcludePinnedStmt
          : getRowAsOfShapeAWithAuthorStmt;
        row = stmt.get(
          topicNarrow,
          args.scope,
          args.target_id,
          args.authored_by,
          args.as_of,
          args.as_of,
        ) as Record<string, unknown> | undefined;
      } else {
        const stmt = excludePinned
          ? getRowAsOfShapeAExcludePinnedStmt
          : getRowAsOfShapeAStmt;
        row = stmt.get(
          topicNarrow,
          args.scope,
          args.target_id,
          args.as_of,
          args.as_of,
        ) as Record<string, unknown> | undefined;
      }
    } else {
      const stmt = excludePinned
        ? getRowAsOfShapeBExcludePinnedStmt
        : getRowAsOfShapeBStmt;
      row = stmt.get(
        topicNarrow,
        args.derived_entity_id,
        args.as_of,
        args.as_of,
      ) as Record<string, unknown> | undefined;
    }
    return row ? rowToRecord(row) : null;
  };

  const getChain = (args: {
    topic: string;
    scope?: EnrichmentScope;
    target_id?: string;
    derived_entity_id?: string;
    authored_by?: string;
    exclude_pinned?: boolean;
    limit?: number;
  }): EnrichmentRecord[] => {
    const { def, topicNarrow } = validateChainArgs(args);
    // Default 100 keeps the typical chain (a handful of historical
    // rows) cheap; max matches `MAX_LIMIT` so callers paging through a
    // pathological chain (test fixtures, audits) aren't throttled.
    const limit = Math.min(Math.max(args.limit ?? 100, 1), MAX_LIMIT);
    const excludePinned = args.exclude_pinned === true;
    let rows: Record<string, unknown>[];
    if (def.shape === 'per_record') {
      if (typeof args.authored_by === 'string' && args.authored_by.length > 0) {
        const stmt = excludePinned
          ? getChainShapeAWithAuthorExcludePinnedStmt
          : getChainShapeAWithAuthorStmt;
        rows = stmt.all(
          topicNarrow,
          args.scope,
          args.target_id,
          args.authored_by,
          limit,
        ) as Record<string, unknown>[];
      } else {
        const stmt = excludePinned
          ? getChainShapeAExcludePinnedStmt
          : getChainShapeAStmt;
        rows = stmt.all(
          topicNarrow,
          args.scope,
          args.target_id,
          limit,
        ) as Record<string, unknown>[];
      }
    } else {
      const stmt = excludePinned
        ? getChainShapeBExcludePinnedStmt
        : getChainShapeBStmt;
      rows = stmt.all(
        topicNarrow,
        args.derived_entity_id,
        limit,
      ) as Record<string, unknown>[];
    }
    return rows.map(rowToRecord);
  };

  const insertVoteStmt = db.prepare(
    `INSERT INTO ${QUALITY_VOTE_TABLE}
       (vote_id, topic, scope, target_id, enrichment_row_id, vote, source,
        corrected_value, context_recipe_id, voted_at, voted_by_client_id,
        agent_session_id, agent_sub_path, routing, pinned_row_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const enqueueRowActionStmt = db.prepare(
    `UPDATE ${ENRICHMENT_TABLE}
        SET lifecycle_action_pending = ?,
            staleness_class = CASE
              WHEN staleness_class = 'fresh' THEN 'stale'
              ELSE staleness_class
            END
      WHERE _id = ?
        AND is_pinned = 0
        AND tombstoned_at IS NULL`,
  );

  const clearFailureCounterStmt = db.prepare(
    `UPDATE ${ENRICHMENT_TABLE}
        SET failure_attempt_count = 0,
            last_failure_reason = NULL
      WHERE _id = ?`,
  );

  const dropVectorByEnrichmentIdStmt = db.prepare(
    `DELETE FROM ${VECTOR_INDEX_TABLE} WHERE enrichment_id = ?`,
  );
  const dropFtsByEnrichmentIdStmt = db.prepare(
    `DELETE FROM ${FTS_TABLE} WHERE enrichment_id = ?`,
  );

  // D-145 § A.7.10 (PA9.7) — vector sidecar read by enrichment id.
  // The LLM result cache's embedding integration reuses the cached
  // row's sidecar so a hit doesn't re-call the embedding adapter.
  const getVectorByEnrichmentIdStmt = db.prepare(
    `SELECT vector FROM ${VECTOR_INDEX_TABLE} WHERE enrichment_id = ?`,
  );
  const getSidecarVector = (enrichment_id: string): Buffer | null => {
    const row = getVectorByEnrichmentIdStmt.get(enrichment_id) as
      | { vector: Buffer | Uint8Array }
      | undefined;
    if (!row) return null;
    // better-sqlite3 hands back a Buffer for BLOB columns in Node;
    // normalize defensively in case a future driver flip yields
    // Uint8Array.
    return Buffer.isBuffer(row.vector) ? row.vector : Buffer.from(row.vector);
  };

  /** Map vote → lifecycle action token using the topic's policy. */
  const recomputeOrDiscardForTopic = (
    def: EnrichmentDefinition,
  ): 'recompute' | 'discard' => {
    // TTL / one-shot topics can't usefully recompute — there's no
    // upstream to re-derive against. Same for topics whose lifecycle
    // policy is `'historical'` (recomputing would corrupt the chain
    // semantics) — we discard those rows as well. Everything else
    // (`dependent` / `aggregate` / `members_list` / `independent`)
    // is recompute-eligible.
    if (def.lifecycle_policy === 'ttl') return 'discard';
    if (def.lifecycle_policy === 'historical') return 'discard';
    return 'recompute';
  };

  const writeQualityVote = (args: {
    topic: string;
    scope?: EnrichmentScope;
    target_id?: string;
    enrichment_row_id: string;
    vote: EnrichmentVoteKind;
    source: EnrichmentVoteSource;
    corrected_value?: unknown;
    context_recipe_id?: string;
    voted_by_client_id: string;
    agent_session_id?: string;
    agent_sub_path?: string;
    voted_at?: number;
  }): {
    vote_id: string;
    routing:
      | 'recompute'
      | 'discard'
      | 'pin_written'
      | 'failure_count_reset'
      | 'noop';
    pinned_row_id: string | null;
  } => {
    if (!ENRICHMENT_VOTE_KINDS.includes(args.vote)) {
      throw new Error(
        `enrichment_vote_kind_unknown: '${String(args.vote)}'`,
      );
    }
    if (!ENRICHMENT_VOTE_SOURCES.includes(args.source)) {
      throw new Error(
        `enrichment_vote_source_unknown: '${String(args.source)}'`,
      );
    }
    if (args.vote === 'corrected' && args.corrected_value === undefined) {
      throw new Error(
        `enrichment_vote_corrected_value_required: vote='corrected' requires corrected_value`,
      );
    }
    if (!isEnrichmentTopic(args.topic)) {
      throw new EnrichmentTopicUnknownError(args.topic);
    }

    const target = getById(args.enrichment_row_id);
    if (!target) {
      throw new Error(
        `enrichment_vote_row_unknown: enrichment_row_id='${args.enrichment_row_id}'`,
      );
    }
    if (target.topic !== args.topic) {
      throw new Error(
        `enrichment_vote_topic_mismatch: row topic='${target.topic}' != vote topic='${args.topic}'`,
      );
    }

    const def = getEnrichmentDefinition(args.topic);
    const vote_id = `vote_${randomUUID()}`;
    const ts = args.voted_at ?? now();

    // P7.A Codex review #4 — when caller supplies `scope` / `target_id`
    // for a corrected vote, they MUST match the fetched row. Otherwise
    // the corrected pinned row would be written under a different
    // record while the vote envelope references the original — a
    // silent identity-mismatch we surface as a hard error so UIs can
    // re-confirm before retrying.
    if (args.scope !== undefined && args.scope !== (target.scope ?? undefined)) {
      throw new Error(
        `enrichment_vote_scope_mismatch: row scope='${target.scope ?? '(none)'}' != vote scope='${args.scope}' for enrichment_row_id='${args.enrichment_row_id}'`,
      );
    }
    if (args.target_id !== undefined && args.target_id !== (target.target_id ?? undefined)) {
      throw new Error(
        `enrichment_vote_target_id_mismatch: row target_id='${target.target_id ?? '(none)'}' != vote target_id='${args.target_id}' for enrichment_row_id='${args.enrichment_row_id}'`,
      );
    }

    // P7.A Codex review #5 — corrected votes on derived-entity topics
    // would reuse the row's `derived_entity_id` for the pinned write,
    // collapsing into the producer's chain head (Shape-B is keyed on
    // `(topic, derived_entity_id)` only — no `authored_by` separation).
    // The resulting pinned row would overwrite or supersede the
    // producer's row, and `vote.delete` would tombstone the original
    // current value rather than restore the producer's view. Reject
    // until the substrate grows independent author chains for derived
    // entities (post-launch enhancement).
    if (args.vote === 'corrected' && def.shape === 'derived_entity') {
      throw new Error(
        `enrichment_vote_corrected_unsupported_for_derived: topic '${args.topic}' is a derived-entity topic; corrected votes are only supported on per-record topics today`,
      );
    }

    let routing:
      | 'recompute'
      | 'discard'
      | 'pin_written'
      | 'failure_count_reset'
      | 'noop' = 'noop';
    let pinned_row_id: string | null = null;
    let pinAuthoredBy: string | null = null;

    // Vote-routing first computes the side-effects (pinned-row write,
    // LAP enqueue, counter clear) so the recorded `routing` column
    // captures the exact outcome. Pinned target rows protect against
    // recompute / discard — vote routing collapses to `'noop'`.
    if (args.vote === 'corrected') {
      pinAuthoredBy = `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.${vote_id}`;
      // P7.A Codex review #4 — pin keys derive ONLY from the fetched
      // target row (caller-supplied scope / target_id are validated
      // against target above; never used as the source of truth).
      // Per-record only at this point — derived-entity branch above
      // rejected.
      const upsertInput: EnrichmentUpsertInput = {
        topic: args.topic,
        scope: target.scope ?? undefined,
        target_id: target.target_id ?? undefined,
        value: args.corrected_value,
        authored_by: pinAuthoredBy,
        event_at: ts,
        mode: 'pinned',
      };
      const pinned = upsert(upsertInput);
      pinned_row_id = pinned._id;
      routing = 'pin_written';
    } else if (args.vote === 'wrong' || args.vote === 'stale') {
      // Pinned target → vote routes to noop (UI may still surface
      // for the user, but the substrate doesn't recompute). Otherwise
      // pick recompute or discard from the topic's policy.
      if (target.is_pinned) {
        routing = 'noop';
      } else {
        const action = recomputeOrDiscardForTopic(def);
        const updated = enqueueRowActionStmt.run(action, args.enrichment_row_id);
        if (updated.changes === 0) {
          // Row was tombstoned or pinned between the read + write —
          // collapse to noop rather than fail the vote ingest.
          routing = 'noop';
        } else {
          routing = action;
          if (action === 'discard') {
            // Discard tombstones the sidecars synchronously per audit
            // §10.2; the next housekeeping cycle's drain finalises
            // the row tombstone.
            dropVectorByEnrichmentIdStmt.run(args.enrichment_row_id);
            dropFtsByEnrichmentIdStmt.run(args.enrichment_row_id);
          }
        }
      }
    } else if (args.vote === 'correct') {
      const updated = clearFailureCounterStmt.run(args.enrichment_row_id);
      routing = updated.changes > 0 ? 'failure_count_reset' : 'noop';
    } else {
      // 'irrelevant' — UI suppression only; substrate persists the
      // vote and stops.
      routing = 'noop';
    }

    insertVoteStmt.run(
      vote_id,
      args.topic,
      args.scope ?? null,
      args.target_id ?? null,
      args.enrichment_row_id,
      args.vote,
      args.source,
      args.corrected_value !== undefined
        ? JSON.stringify(args.corrected_value)
        : null,
      args.context_recipe_id ?? null,
      ts,
      args.voted_by_client_id,
      args.agent_session_id ?? null,
      args.agent_sub_path ?? null,
      routing,
      pinned_row_id,
    );

    return { vote_id, routing, pinned_row_id };
  };

  const getVoteStmt = db.prepare(
    `SELECT * FROM ${QUALITY_VOTE_TABLE} WHERE vote_id = ?`,
  );
  const deleteVoteStmt = db.prepare(
    `DELETE FROM ${QUALITY_VOTE_TABLE} WHERE vote_id = ?`,
  );
  const tombstonePinnedRowStmt = db.prepare(
    `UPDATE ${ENRICHMENT_TABLE}
        SET tombstoned_at = ?,
            tombstone_reason = 'user_discarded',
            staleness_class = 'expired',
            value = NULL,
            meta = NULL,
            lifecycle_action_pending = NULL
      WHERE _id = ?`,
  );

  const rowToVote = (row: Record<string, unknown>) => ({
    vote_id: String(row.vote_id),
    topic: String(row.topic),
    scope: (row.scope as EnrichmentScope | null) ?? null,
    target_id: (row.target_id as string | null) ?? null,
    enrichment_row_id: String(row.enrichment_row_id),
    vote: row.vote as EnrichmentVoteKind,
    source: row.source as EnrichmentVoteSource,
    corrected_value:
      typeof row.corrected_value === 'string'
        ? safeJsonParse(row.corrected_value)
        : null,
    context_recipe_id: (row.context_recipe_id as string | null) ?? null,
    voted_at: Number(row.voted_at),
    voted_by_client_id: String(row.voted_by_client_id),
    agent_session_id: (row.agent_session_id as string | null) ?? null,
    agent_sub_path: (row.agent_sub_path as string | null) ?? null,
    routing: (row.routing as string | null) ?? null,
    pinned_row_id: (row.pinned_row_id as string | null) ?? null,
  });

  const getQualityVote = (vote_id: string) => {
    const row = getVoteStmt.get(vote_id) as Record<string, unknown> | undefined;
    return row ? rowToVote(row) : null;
  };

  const deleteQualityVote = (
    vote_id: string,
  ): { ok: true; pin_unwound: boolean } => {
    const row = getVoteStmt.get(vote_id) as Record<string, unknown> | undefined;
    if (!row) return { ok: true, pin_unwound: false };
    const pinnedId = (row.pinned_row_id as string | null) ?? null;
    let pin_unwound = false;
    if (pinnedId) {
      // Tombstone-with-id per audit §10.2 — preserve `_id` + `event_at`
      // for D-120 link-graph + timeline lookups, NULL the value /
      // meta + drop sidecars, mark `expired`. Idempotent: if the
      // pinned row was already tombstoned by another path, the
      // tombstoned_at update over-writes harmlessly.
      tombstonePinnedRowStmt.run(now(), pinnedId);
      dropVectorByEnrichmentIdStmt.run(pinnedId);
      dropFtsByEnrichmentIdStmt.run(pinnedId);
      pin_unwound = true;
    }
    deleteVoteStmt.run(vote_id);
    return { ok: true, pin_unwound };
  };

  const listQualityVotes = (filter: {
    topic?: string;
    enrichment_row_id?: string;
    source?: EnrichmentVoteSource;
    vote?: EnrichmentVoteKind;
    limit?: number;
  }) => {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.topic !== undefined) {
      where.push('topic = ?');
      args.push(filter.topic);
    }
    if (filter.enrichment_row_id !== undefined) {
      where.push('enrichment_row_id = ?');
      args.push(filter.enrichment_row_id);
    }
    if (filter.source !== undefined) {
      where.push('source = ?');
      args.push(filter.source);
    }
    if (filter.vote !== undefined) {
      where.push('vote = ?');
      args.push(filter.vote);
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    args.push(limit);
    const sql = `SELECT * FROM ${QUALITY_VOTE_TABLE}
                  ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                  ORDER BY voted_at DESC
                  LIMIT ?`;
    const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map(rowToVote);
  };

  // ── D-136 §A.12 P7 — topic reset substrate ────────────────────

  /** Build the WHERE clauses + arg list for the `(topic, scope_filter?)`
   *  predicate shared by countMatchingForReset +
   *  tombstoneAndEnqueueRecomputeByTopic + the implied implicit-chain-
   *  head filter (`superseded_by_id IS NULL` — only current heads, not
   *  historical chain rows). The predicate also strips already-tombstoned
   *  rows so a re-run of topic-reset is idempotent. */
  const buildResetPredicate = (
    topic: string,
    scope_filter: EnrichmentScope | undefined,
  ): { where: string; args: (string | number)[] } => {
    const where: string[] = [
      'topic = ?',
      'superseded_by_id IS NULL',
      'tombstoned_at IS NULL',
    ];
    const args: (string | number)[] = [topic];
    if (scope_filter !== undefined) {
      where.push('scope = ?');
      args.push(scope_filter);
    }
    return { where: where.join(' AND '), args };
  };

  const countMatchingForReset = (input: {
    topic: string;
    scope_filter?: EnrichmentScope;
  }): { rows_to_tombstone: number; pinned_protected: number } => {
    const { where, args } = buildResetPredicate(input.topic, input.scope_filter);
    const total = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM ${ENRICHMENT_TABLE} WHERE ${where}`)
        .get(...args) as { n: number }
    ).n;
    const pinned = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${ENRICHMENT_TABLE}
            WHERE ${where} AND is_pinned = 1`,
        )
        .get(...args) as { n: number }
    ).n;
    return {
      rows_to_tombstone: total - pinned,
      pinned_protected: pinned,
    };
  };

  // `confidence_drift_signal` is a derived-entity topic whose
  // `derived_entity_id` IS the source-topic name (per
  // `extractDriftSignalSourceTopic` in the registry). Both
  // count + drop helpers narrow on `(topic = 'confidence_drift_signal',
  // derived_entity_id = source_topic)`. We don't filter
  // `superseded_by_id IS NULL` because the drop intentionally clears
  // the entire historical chain — PSI baselines lose meaning when the
  // source-topic data has been reset.
  const countDriftBaselinesStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ${ENRICHMENT_TABLE}
      WHERE topic = 'confidence_drift_signal'
        AND derived_entity_id = ?
        AND tombstoned_at IS NULL`,
  );
  const countConfidenceDriftBaselinesForTopic = (source_topic: string): number =>
    (countDriftBaselinesStmt.get(source_topic) as { n: number }).n;

  const dropDriftBaselinesStmt = db.prepare(
    `DELETE FROM ${ENRICHMENT_TABLE}
      WHERE topic = 'confidence_drift_signal'
        AND derived_entity_id = ?`,
  );
  const dropConfidenceDriftBaselinesForTopic = (source_topic: string): number =>
    dropDriftBaselinesStmt.run(source_topic).changes as number;

  const tombstoneAndEnqueueRecomputeByTopic = (input: {
    topic: string;
    scope_filter?: EnrichmentScope;
  }): {
    rows_tombstoned: number;
    rows_recompute_enqueued: number;
    pinned_skipped: number;
  } => {
    const { where, args } = buildResetPredicate(input.topic, input.scope_filter);
    // Pull every candidate row id in one shot; pinned rows are
    // counted but excluded from tombstone + LAP-enqueue.
    const candidates = db
      .prepare(
        `SELECT _id, is_pinned FROM ${ENRICHMENT_TABLE} WHERE ${where}`,
      )
      .all(...args) as { _id: string; is_pinned: number | null }[];

    const non_pinned_ids = candidates
      .filter((r) => (r.is_pinned ?? 0) === 0)
      .map((r) => r._id);
    const pinned_skipped = candidates.length - non_pinned_ids.length;
    if (non_pinned_ids.length === 0) {
      return { rows_tombstoned: 0, rows_recompute_enqueued: 0, pinned_skipped };
    }

    // Tombstone first per audit §10.2 — NULL value/meta + drop
    // sidecars + mark expired. Then re-enqueue LAP=recompute on the
    // same row set so the next housekeeping cycle re-derives.
    const tombstoned = tombstoneRowIds(non_pinned_ids, 'user_discarded');

    const ts = now();
    // Set LAP=recompute on the tombstoned rows. Pinned filter is
    // defensive (tombstoneRowIds already skipped pinned, but the row
    // set we pass here is already non-pinned-by-construction).
    const placeholders = non_pinned_ids.map(() => '?').join(', ');
    const enqueued = db
      .prepare(
        `UPDATE ${ENRICHMENT_TABLE}
            SET lifecycle_action_pending = 'recompute',
                staleness_class = 'expired',
                last_evaluated_at = ?
          WHERE _id IN (${placeholders})
            AND is_pinned = 0`,
      )
      .run(ts, ...non_pinned_ids).changes as number;

    return {
      rows_tombstoned: tombstoned,
      rows_recompute_enqueued: enqueued,
      pinned_skipped,
    };
  };

  return {
    upsert,
    // D-192 S4b — the public scope-support predicate (resolves `def` internally),
    // so the MCP read handler consults the SAME widened gate the store's upsert +
    // chain-walk use. A non-per_record / unknown topic has no scope → false.
    isScopeSupported: (topic: string, scope: string): boolean => {
      if (!isEnrichmentTopic(topic)) return false;
      const def = getEnrichmentDefinition(topic);
      if (def.shape !== 'per_record') return false;
      return isScopeWritable(def, scope as EnrichmentScope);
    },
    getByRecord,
    getDerived,
    getSidecarVector,
    getById,
    getRowAsOf,
    getChain,
    list,
    listTopicsWithRows,
    listByTarget,
    refreshMetaForTarget,
    listScopeMeta,
    deleteById,
    deleteForSource,
    deleteForScopeAndTargetPrefix,
    listChainHeadRowIdsByScopeAndTargetPrefix,
    markStaleByAuthor,
    markStaleForSource,
    trimMember,
    enqueueLifecycleActionForTopic,
    countTopicEnqueueCandidates,
    listLifecycleActionPending,
    countLifecycleActionPendingByTopic,
    listConsumerRowIdsOfUpstream,
    listChainHeadRowIdsByTopicAndTargets,
    listChainHeadRowIdsByProducerVersion,
    listChainHeadRowIdsByScopeAndTarget,
    listChainHeadRowIdsByScopeAndTargetPattern,
    markStaleAndEnqueueByRowIds,
    listStaleRowsForReDerive,
    tombstoneRowIds,
    recordProducerFailure,
    writeQualityVote,
    deleteQualityVote,
    getQualityVote,
    listQualityVotes,
    countMatchingForReset,
    countConfidenceDriftBaselinesForTopic,
    tombstoneAndEnqueueRecomputeByTopic,
    dropConfidenceDriftBaselinesForTopic,
    reset,
    count,
    countForTopic,
    getLatestEventAtForTopic,
    close: (): void => {
      // No long-lived resources to release; the underlying db is
      // owned by the caller.
    },
  };
};

const safeJsonParse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** SQL string-literal escaper. Used in the markStale paths above where
 *  we run a sub-select inside DELETE — better-sqlite3's `.exec` doesn't
 *  bind parameters, so we inline + escape. Inputs come from internal
 *  callers (recipe ids, scope enum, target ids that are already
 *  validated upstream), but we still escape for defense-in-depth. */
const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
