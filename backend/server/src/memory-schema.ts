/** D-120 Phase 1 — Memory + provenance schema foundations.
 *
 *  Lays down three pieces:
 *
 *    1. `recipe_insights` table + `(slug, version)` index. Content-
 *       addressed snapshots of recipe shape at execution time so
 *       memory entries stay interpretable across recipe upgrades.
 *
 *    2. `links` table + 3 indexes. Engine-emitted causal edges between
 *       a memory entry and the entities a step touched. Composite
 *       primary key `(memory_id, entity_id, kind, ts)` keeps repeated
 *       per-tick emissions distinct.
 *
 *    3. `json_extract` indexes on `audit_entries` for `output_string`
 *       + `recipe_insight_id`. Our existing audit storage is JSON-in-
 *       blob (`createSQLiteCollection`), so the spec's
 *       `ALTER TABLE audit_log ADD COLUMN` translates to an
 *       `AuditEntry` interface extension + json_extract indexes —
 *       same pattern Phase B used for the retention pruner.
 *
 *  Phase 1 ships schema only — no inserts, no backfill. Phase 2 wires
 *  recipe-insight population, Phase 3 wires link emission, Phase 7
 *  wires `output_string` capture at run finish.
 *
 *  All statements are idempotent (`IF NOT EXISTS`) — safe to call on
 *  every boot and from migration tests.
 *
 *  Spec: docs/d-120-spec.md.
 */

import type Database from 'better-sqlite3';
import { LINK_KINDS } from '@recued/contracts';

/** SQL fragment listing every defined `LinkKind` as a quoted CSV.
 *  Used to assemble the `kind IN (…)` CHECK constraint on the `links`
 *  table without hardcoding the values twice. */
const LINK_KIND_CHECK_LIST = LINK_KINDS.map((k) => `'${k}'`).join(', ');

/** Install all D-120 Phase 1 schema additions on `db`. Safe to call
 *  multiple times — every statement uses `IF NOT EXISTS`. Caller is
 *  responsible for invoking this once at boot, after the audit
 *  collections have been created (the audit json_extract indexes
 *  presume the `audit_entries` table already exists, same as the
 *  Phase B `ensureAuditIndexes` contract). */
export const ensureMemorySchema = (db: Database.Database): void => {
  db.exec(`
    -- Content-addressed recipe-shape snapshots. 'hash' is the natural
    -- key (FNV-1a; matches the existing audit_log.recipe_hash);
    -- 'id' is a surrogate INTEGER used by the links table as a
    -- fast-join FK (4-byte int vs 32-byte hex — 3 MB saved per 100K
    -- link rows plus B-tree page efficiency).
    CREATE TABLE IF NOT EXISTS recipe_insights (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      hash        TEXT    NOT NULL UNIQUE,
      slug        TEXT    NOT NULL,
      version     INTEGER NOT NULL,
      flattened   TEXT    NOT NULL,
      created_at  INTEGER NOT NULL,
      -- D-120 Phase 7.5 — first-observed event date, when known.
      -- Surfaces alongside the audit row's run_mode for L4 retention
      -- overrides (D-121); nullable + idempotent in
      -- ensureBistemporalSchema for upgrade paths.
      event_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_recipe_insights_slug_version
      ON recipe_insights (slug, version);

    -- Engine-emitted provenance edges. Composite PK keeps repeated
    -- per-tick emissions distinct (reactive recipe firing 100×/day
    -- against the same entity = 100 distinct rows, one per ts).
    -- Foreign key onto recipe_insights so cascade-aware vacuum can
    -- detect orphaned insights at retention time (Phase 7).
    CREATE TABLE IF NOT EXISTS links (
      memory_id          TEXT    NOT NULL,
      entity_id          TEXT    NOT NULL,
      recipe_insight_id  INTEGER NOT NULL,
      kind               TEXT    NOT NULL CHECK (kind IN (${LINK_KIND_CHECK_LIST})),
      ts                 INTEGER NOT NULL,
      -- D-120 Phase 7.5 — bistemporal stamp; nullable so pre-7.5
      -- emissions still pass the NOT NULL gate. Existing deployments
      -- pick the column up via ensureBistemporalSchema's ALTER branch
      -- below; fresh installs get it here.
      event_at           INTEGER,
      -- D-161 P1 — origin provenance facet. A provenance link is emitted
      -- during a recipe run, so origin_actor is the run's
      -- ExecutionSource.actor (propagated at the insertLinks seam — I-6),
      -- defaulting to 'system' for sync/housekeeping runs that carry no
      -- typed source. NOT NULL DEFAULT 'system' so every link row carries
      -- a non-null write-actor (I-5); the ALTER branch below upgrades
      -- existing dev-DB rows. origin_contract_id present iff contracted.
      origin_actor       TEXT    NOT NULL DEFAULT 'system',
      origin_contract_id TEXT,
      PRIMARY KEY (memory_id, entity_id, kind, ts),
      FOREIGN KEY (recipe_insight_id) REFERENCES recipe_insights(id)
    );
    CREATE INDEX IF NOT EXISTS idx_links_entity_ts
      ON links (entity_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_links_recipe_insight
      ON links (recipe_insight_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_links_memory
      ON links (memory_id);

    -- audit_entries JSON-blob index additions. The spec's literal
    -- 'ALTER TABLE audit_log ADD COLUMN' translates here to
    -- json_extract indexes on the existing JSON column, mirroring
    -- the Phase B retention-pruner pattern. Field names match the
    -- AuditEntry interface extension (output_string + recipe_insight_id).
    CREATE INDEX IF NOT EXISTS audit_entries_output_string_idx
      ON audit_entries (json_extract(data, '$.output_string'));
    CREATE INDEX IF NOT EXISTS audit_entries_recipe_insight_id_idx
      ON audit_entries (json_extract(data, '$.recipe_insight_id'),
                        json_extract(data, '$.started_at'));
    -- D-153 P1 — three-tier session ID indexes. The engine writes
    -- channel_session_id (channel's own boundary), cognition_session_id
    -- (engine-assigned per cognition window), and correlation_id
    -- (engine-assigned per ~1-min intent burst). The three queries
    -- ("what happened in this Slack thread ever?" / "what did this
    -- cognition arc do?" / "what was this dentist task?") each hit one
    -- index. Today's pre-D-145 recipe-runner leaves the fields
    -- undefined; the indexes cost nothing until the engine wires them.
    CREATE INDEX IF NOT EXISTS audit_entries_channel_session_id_idx
      ON audit_entries (json_extract(data, '$.channel_session_id'),
                        json_extract(data, '$.started_at'));
    CREATE INDEX IF NOT EXISTS audit_entries_cognition_session_id_idx
      ON audit_entries (json_extract(data, '$.cognition_session_id'),
                        json_extract(data, '$.started_at'));
    CREATE INDEX IF NOT EXISTS audit_entries_correlation_id_idx
      ON audit_entries (json_extract(data, '$.correlation_id'),
                        json_extract(data, '$.started_at'));
  `);
};

/** Get-or-create a recipe-insight row by content hash. Returns the
 *  surrogate `id` for downstream FK use (links + audit_log
 *  recipe_insight_id pointer). Idempotent: same hash always returns
 *  the same id, even across processes — `hash` is `UNIQUE` and the
 *  `ON CONFLICT … DO NOTHING` keeps the existing row.
 *
 *  `flattened` is the AI-readable action-summary JSON; callers must
 *  already have validated its size against
 *  `RECIPE_INSIGHT_FLATTENED_MAX_BYTES`. Phase 2 ships the flattener
 *  in `packages/recipes/src/flatten.ts`; Phase 1 exposes the insert
 *  helper so the storage round-trip is testable end-to-end. */
export interface RecipeInsightUpsert {
  hash: string;
  slug: string;
  version: number;
  flattened: string;
  created_at?: number;
}

export const getOrCreateRecipeInsight = (
  db: Database.Database,
  insight: RecipeInsightUpsert,
): number => {
  const created_at = insight.created_at ?? Date.now();
  db.prepare(
    `INSERT INTO recipe_insights (hash, slug, version, flattened, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO NOTHING`,
  ).run(insight.hash, insight.slug, insight.version, insight.flattened, created_at);
  const row = db
    .prepare(`SELECT id FROM recipe_insights WHERE hash = ?`)
    .get(insight.hash) as { id: number } | undefined;
  if (!row) {
    // Theoretically unreachable — the INSERT above either inserted or
    // collided with an existing row, both of which leave a row visible.
    // Throw rather than return a sentinel so storage callers fail fast
    // if an unexpected concurrent vacuum runs between the two statements.
    throw new Error(`recipe_insights row missing after upsert: hash=${insight.hash}`);
  }
  return row.id;
};

// ────────────────────────────────────────────────────────────────
// D-120 Phase 7.5 — bistemporal stamping + run_mode migration
// ────────────────────────────────────────────────────────────────

/** True if `table` already has `column`. SQLite keeps full pragma
 *  metadata so the check is O(1). Used to keep the bistemporal
 *  migration idempotent — second boot doesn't `ALTER TABLE` again. */
const hasColumn = (
  db: Database.Database,
  table: string,
  column: string,
): boolean => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.some((r) => r.name === column);
};

/** Install Phase 7.5 bistemporal columns + indexes. Idempotent —
 *  every step checks pragma table_info before issuing ALTER, every
 *  index uses `IF NOT EXISTS`. Safe to call on every boot.
 *
 *  Pre-7.5 rows leave `event_at` NULL; queries fall back to ingestion
 *  time via `COALESCE(event_at, ts)` so behavior is unchanged for
 *  data already on disk. New writes from Phase 7.5+ stamp `event_at`
 *  when the engine has a real-world date in hand (mail Date: header,
 *  calendar event start, etc.).
 *
 *  `audit_entries` is JSON-blob — the schema additions land as
 *  `json_extract` indexes on the existing `data` column, mirroring
 *  the Phase 1 pattern. The shape itself extends `AuditEntry` in
 *  `@recued/storage` so writes carry `event_at` / `run_mode` inside
 *  the JSON payload automatically. */
export const ensureBistemporalSchema = (db: Database.Database): void => {
  // recipe_insights.event_at — set by callers that know the recipe
  // first observed event date; kept nullable so legacy inserts work.
  if (!hasColumn(db, 'recipe_insights', 'event_at')) {
    db.exec(`ALTER TABLE recipe_insights ADD COLUMN event_at INTEGER`);
  }
  // links.event_at (D-120 Phase 3 provenance table — distinct from the
  // D-119 `link` typed-relationship table). Backfill recipes' emitted
  // links pass through the source record's date_header so timeline
  // queries can sort by event time.
  if (!hasColumn(db, 'links', 'event_at')) {
    db.exec(`ALTER TABLE links ADD COLUMN event_at INTEGER`);
  }
  // D-119 Phase 13 annotation table — `annotation` (singular). Same
  // semantics as the link addition above.
  if (!hasColumn(db, 'annotation', 'event_at')) {
    db.exec(`ALTER TABLE annotation ADD COLUMN event_at INTEGER`);
  }
  // D-119 Phase 13 link table — `link` (singular).
  if (!hasColumn(db, 'link', 'event_at')) {
    db.exec(`ALTER TABLE link ADD COLUMN event_at INTEGER`);
  }

  // D-161 P1 — origin provenance facet on the D-120 provenance `links`
  // (plural) table. `origin_actor` is NOT NULL DEFAULT 'system' so
  // existing rows + any insert that omits it carry a non-null write-actor
  // (I-5); `origin_contract_id` is nullable (present iff contracted, N.4).
  // Fresh installs get the columns from the CREATE TABLE above; this is
  // the additive upgrade for DBs that predate the column. Pre-launch zero
  // installs — no backfill beyond the column default.
  //
  // The D-119 `annotation` + `link` (singular) sidecar collections are
  // deliberately NOT stamped in P1: they are not in the spec's A.4
  // four-kind enumeration (they are sidecars, per `SIDECAR_COLLECTIONS`),
  // and stamping them without threading the real write-actor through the
  // `data-annotate` / `data-link` kernel adapters would mislabel an
  // MCP-written annotation as `'system'`. Their origin lands in P2, where
  // the producer provenance-filter generalises D-139's `authorship`
  // classifier and consumes the facet.
  if (!hasColumn(db, 'links', 'origin_actor')) {
    db.exec(
      `ALTER TABLE links ADD COLUMN origin_actor TEXT NOT NULL DEFAULT 'system'`,
    );
  }
  if (!hasColumn(db, 'links', 'origin_contract_id')) {
    db.exec(`ALTER TABLE links ADD COLUMN origin_contract_id TEXT`);
  }

  // Indexes for the new ordering surfaces. `idx_links_entity_event`
  // is the primary read path for `data.timeline()` event-axis queries
  // — entity scan + COALESCE ordering. `idx_audit_run_mode_started`
  // pre-clusters audit rows by run_mode for the L4 retention overrides
  // landing in D-121 (per-mode windows).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_links_entity_event
      ON links (entity_id, COALESCE(event_at, ts) DESC);
    CREATE INDEX IF NOT EXISTS audit_entries_run_mode_started_idx
      ON audit_entries (
        json_extract(data, '$.run_mode'),
        json_extract(data, '$.started_at') DESC
      );
    CREATE INDEX IF NOT EXISTS audit_entries_event_at_idx
      ON audit_entries (json_extract(data, '$.event_at'));
  `);
};

/** D-122 Phase 2 — `link.confidence` + `link.evidence` for the
 *  `link-create` graph-builder ingredient. Same idempotency pattern as
 *  the bistemporal migration: ALTER TABLE only when the column is
 *  missing, so re-boots are no-ops. The columns are nullable; pre-D-122
 *  rows survive untouched and read back with `confidence === undefined`
 *  / `evidence === undefined` through the store's row mapper.
 *
 *  No new index — the columns aren't filterable through `LinkFilter`,
 *  and the natural read path (per-record outbound/inbound links) already
 *  serves through the `link_from_idx` / `link_to_idx` covering paths. */
export const ensureLinkConfidenceSchema = (db: Database.Database): void => {
  if (!hasColumn(db, 'link', 'confidence')) {
    db.exec(`ALTER TABLE link ADD COLUMN confidence REAL`);
  }
  if (!hasColumn(db, 'link', 'evidence')) {
    db.exec(`ALTER TABLE link ADD COLUMN evidence TEXT`);
  }
};

// ────────────────────────────────────────────────────────────────
// D-145 engine-wiring slice 3a — D-153 commit-substrate indexes
// ────────────────────────────────────────────────────────────────

/** Install the `json_extract` indexes for the `commits` table — the
 *  D-153 atomic commit log (one boundary-crossing tool call = one
 *  commit; see `CommitStore` in `@recued/storage`).
 *
 *  The `commits` table is stored via `createSQLiteCollection` as opaque
 *  JSON in a `(key, data)` table — the same shape as `audit_entries`.
 *  These indexes back the query paths that select commits by a field
 *  rather than by the `commit_id` primary key:
 *
 *    - `status`            — the crash-recovery sweep ("every
 *                            non-terminal commit") + future retention.
 *    - `correlation_id` / `channel_session_id` / `cognition_session_id`
 *                          — the three tier-scoped commit queries, each
 *                            composite with `dispatched_at` (the read
 *                            order) so the index covers the sort too.
 *    - `request_id`        — the recipe-run-grouping FK (→ the
 *                            execution-request anchor's `run_id`). Backs
 *                            the "execution request including its
 *                            steps" view (the anchor joined to its
 *                            commits) + per-run retention; composite
 *                            with `dispatched_at` like the session
 *                            tiers so the join reads in dispatch order.
 *    - `idempotency_key`   — the resume-protocol dedup lookup.
 *    - `dispatched_at`     — the retention age pass.
 *
 *  Mirrors `audit-indexes.ts` + the D-153 P1 session-ID indexes in
 *  `ensureMemorySchema`. Idempotent (`IF NOT EXISTS`) — safe on every
 *  boot.
 *
 *  Unlike `ensureMemorySchema`, this is NOT folded into that function:
 *  the `commits` table does not exist at the point `ensureMemorySchema`
 *  runs — it is auto-created by `createSQLiteCollection(db, 'commits')`
 *  only when the server instantiates the `CommitStore`. This function
 *  presumes the table exists, exactly as `ensureMemorySchema`'s audit
 *  indexes presume `audit_entries`. D-145 slice 3a ships the function;
 *  slice 3b.1 instantiates the store at boot and calls this after the
 *  collection is created — the Gateway dispatch-outbox (slice 3b.3) is
 *  the first writer.
 *
 *  Spec: docs/d-153-spec.md § Commit substrate. */
export const ensureCommitSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE INDEX IF NOT EXISTS commits_status_idx
      ON commits (json_extract(data, '$.status'));
    CREATE INDEX IF NOT EXISTS commits_correlation_id_idx
      ON commits (json_extract(data, '$.correlation_id'),
                  json_extract(data, '$.dispatched_at'));
    CREATE INDEX IF NOT EXISTS commits_channel_session_id_idx
      ON commits (json_extract(data, '$.channel_session_id'),
                  json_extract(data, '$.dispatched_at'));
    CREATE INDEX IF NOT EXISTS commits_cognition_session_id_idx
      ON commits (json_extract(data, '$.cognition_session_id'),
                  json_extract(data, '$.dispatched_at'));
    CREATE INDEX IF NOT EXISTS commits_request_id_idx
      ON commits (json_extract(data, '$.request_id'),
                  json_extract(data, '$.dispatched_at'));
    CREATE INDEX IF NOT EXISTS commits_idempotency_key_idx
      ON commits (json_extract(data, '$.idempotency_key'));
    CREATE INDEX IF NOT EXISTS commits_dispatched_at_idx
      ON commits (json_extract(data, '$.dispatched_at'));
  `);
};

// ────────────────────────────────────────────────────────────────
// D-157 P1 — preflight checkpoint-store indexes
// ────────────────────────────────────────────────────────────────

/** Install the `json_extract` indexes for the `checkpoints` table —
 *  the D-157 preflight checkpoint store (the resumable state a
 *  preflight-gated run is re-instantiated from; see `CheckpointStore`
 *  in `@recued/storage`).
 *
 *  The `checkpoints` table is stored via `createSQLiteCollection` as
 *  opaque JSON in a `(key, data)` table — the same shape as `commits`
 *  / `audit_entries`. These indexes back the two query paths that
 *  select a checkpoint by a field rather than by the `checkpoint_id`
 *  primary key:
 *
 *    - `run_id`     — `CheckpointStore.listByRun`: a boot sweep pairing
 *                     an `awaiting_approval` run anchor with its
 *                     checkpoint. Composite with `created_at` (the read
 *                     order) so the index covers the sort too.
 *    - `created_at` — `CheckpointStore.list`: the oldest-first walk for
 *                     D-157's optional staleness guard.
 *
 *  Mirrors `ensureCommitSchema` above. Idempotent (`IF NOT EXISTS`) —
 *  safe on every boot. Like `ensureCommitSchema`, this is NOT folded
 *  into `ensureMemorySchema`: the `checkpoints` table does not exist at
 *  the point that function runs — it is auto-created by
 *  `createSQLiteCollection(db, 'checkpoints')` only when the server
 *  instantiates the `CheckpointStore`. D-157 P1 slice 1 ships this
 *  function alongside the store; the slice that instantiates the store
 *  at boot (the engine pause/resume wiring) calls it after the
 *  collection is created — exactly the slice-3a-ships /
 *  slice-3b.1-calls split `ensureCommitSchema` followed.
 *
 *  Spec: docs/d-157-spec.md § A.2 / N.3. */
export const ensureCheckpointSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE INDEX IF NOT EXISTS checkpoints_run_id_idx
      ON checkpoints (json_extract(data, '$.run_id'),
                      json_extract(data, '$.created_at'));
    CREATE INDEX IF NOT EXISTS checkpoints_created_at_idx
      ON checkpoints (json_extract(data, '$.created_at'));
  `);
};
