/** D-123 Phase 1 + D-132 Phase 1 — Housekeeping persistence schema.
 *
 *  Server-internal tables, idempotent CREATE IF NOT EXISTS plus
 *  conditional ALTER TABLE for additive migrations. All tables live
 *  outside any namespace — never reach the WS rpc surface as data,
 *  no cross-cloud sync (D-097 / D-168). Same shape as
 *  `auto_run_circuit` and `calendar_watcher_cursors`.
 *
 *  Spec: D-123 §1.2 + D-132 A.1 / A.3. */

import type Database from 'better-sqlite3';

/** Idempotent column-presence check for additive migrations. SQLite
 *  ALTER TABLE ADD COLUMN doesn't carry IF NOT EXISTS, so callers
 *  pragma-info first and skip when the column is already present.
 *  Same pattern as `memory-schema.ts:hasColumn`. */
const hasColumn = (
  db: Database.Database,
  table: string,
  column: string,
): boolean => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
};

/** D-136 §A.6 — default daily token budgets for housekeeping. The free
 *  pool budget is set high enough to cover a typical week of casual
 *  use without hitting the cap; the BYOK budget is one order of
 *  magnitude higher (paid users absorb more producer churn).
 *  Cascade-budget defaults live alongside in `housekeeping_config`
 *  per spec §A.6 / §A.7. P2 ships the columns; P5 wires the
 *  walk-cap budget mechanism that consumes them. */
export const D136_DEFAULT_DAILY_TOKEN_BUDGET_FREE = 1_000_000;
export const D136_DEFAULT_DAILY_TOKEN_BUDGET_BYOK = 10_000_000;
export const D136_DEFAULT_CASCADE_BUDGET_PER_SECOND_PER_IDENTITY = 100;
export const D136_DEFAULT_CASCADE_QUEUE_DEPTH_MAX_PER_TOPIC = 10_000;

export const ensureHousekeepingSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS housekeeping_config (
      id                                       TEXT PRIMARY KEY,
      preset                                   TEXT NOT NULL,
      cycle_budget_ms                          INTEGER NOT NULL,
      cycle_interval_minutes                   INTEGER NOT NULL,
      custom_window_start_hour                 INTEGER,
      custom_window_end_hour                   INTEGER,
      daily_token_budget_free                  INTEGER NOT NULL DEFAULT ${D136_DEFAULT_DAILY_TOKEN_BUDGET_FREE},
      daily_token_budget_byok                  INTEGER NOT NULL DEFAULT ${D136_DEFAULT_DAILY_TOKEN_BUDGET_BYOK},
      cascade_budget_per_second_per_identity   INTEGER NOT NULL DEFAULT ${D136_DEFAULT_CASCADE_BUDGET_PER_SECOND_PER_IDENTITY},
      cascade_queue_depth_max_per_topic        INTEGER NOT NULL DEFAULT ${D136_DEFAULT_CASCADE_QUEUE_DEPTH_MAX_PER_TOPIC},
      updated_at                               INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS housekeeping_state (
      task_id                     TEXT PRIMARY KEY,
      cursor_json                 TEXT NOT NULL,
      last_run_at                 INTEGER,
      last_run_duration_ms        INTEGER,
      last_yield_reason           TEXT,
      last_status                 TEXT NOT NULL DEFAULT 'pending',
      consecutive_errors          INTEGER NOT NULL DEFAULT 0,
      last_error                  TEXT,
      tokens_consumed_today_free  INTEGER NOT NULL DEFAULT 0,
      tokens_consumed_today_byok  INTEGER NOT NULL DEFAULT 0,
      budget_window_start         INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_housekeeping_state_status
      ON housekeeping_state (last_status, last_run_at);

    -- D-132 — per-topic trust state + pool policy. Single-row upsert
    -- keyed on topic; absent row means "registry default." Includes
    -- the manual_run_count + promotion-suggestion bookkeeping the
    -- D-132 spec calls for (A.8). NOT NULL on the trust + pool fields
    -- so missing-row vs zeroed-row stay distinguishable upstream.
    CREATE TABLE IF NOT EXISTS enrichment_trust (
      topic                       TEXT PRIMARY KEY,
      trust_state                 TEXT NOT NULL,
      pool_policy                 TEXT NOT NULL,
      manual_run_count            INTEGER NOT NULL DEFAULT 0,
      promotion_suggested_at      INTEGER,
      promotion_dismissed_at      INTEGER,
      updated_at                  INTEGER NOT NULL
    );

    -- D-145 § A.7.8 (Amended 2026-05-26) — per-topic user-tunable
    -- parameters. Absent row means registry default applies. Single-row
    -- upsert keyed on (topic, param_name). Per-pair, server-side,
    -- governs the housekeeping cycle that writes data_enrichment rows
    -- (per-pair = per-server by construction — different clients paired
    -- to the same server see the same tuned values). The value column
    -- is JSON-encoded at write time so the store can carry both number
    -- and string kinds through one TEXT column without a discriminator.
    CREATE TABLE IF NOT EXISTS enrichment_tunable_params (
      topic         TEXT NOT NULL,
      param_name    TEXT NOT NULL,
      value         TEXT NOT NULL,
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (topic, param_name)
    );

    -- D-145 § A.7.10 (Amended 2026-05-26) — content-addressed LLM
    -- result cache. Pointer-only: result_path references the
    -- data_enrichment row written by the first producer to see this
    -- input; readers verify hash(value_at_path) against result_hash
    -- defensively. Per-pair (no cross-pair sharing). Hard-ordered
    -- AFTER § A.7.9 universal cleanup — without it the cache
    -- accumulates dangling refs without bound.
    CREATE TABLE IF NOT EXISTS llm_result_cache (
      input_hash    TEXT PRIMARY KEY,
      result_hash   TEXT NOT NULL,
      result_path   TEXT NOT NULL,
      computed_at   INTEGER NOT NULL,
      hit_count     INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_llm_cache_result_path
      ON llm_result_cache (result_path);
    CREATE INDEX IF NOT EXISTS idx_llm_cache_computed_at
      ON llm_result_cache (computed_at);
  `);

  // D-132 — additive migration on housekeeping_config for the global
  // BYOK master switch + transient pause-AI timestamp. Both default
  // to the conservative state: BYOK off (free pool only for every
  // background producer), pause-AI cleared.
  if (!hasColumn(db, 'housekeeping_config', 'allow_byok_background')) {
    db.exec(
      `ALTER TABLE housekeeping_config ADD COLUMN allow_byok_background INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!hasColumn(db, 'housekeeping_config', 'pause_background_ai_until')) {
    db.exec(
      `ALTER TABLE housekeeping_config ADD COLUMN pause_background_ai_until INTEGER`,
    );
  }

  // D-132 — additive migration on housekeeping_state for the last-N
  // error ring buffer. Newest-first JSON array of HousekeepingErrorEntry;
  // existing single `last_error` column stays as-is for back-compat
  // with status reads. The ring buffer feeds the per-topic detail
  // drawer's error-history panel (A.7).
  if (!hasColumn(db, 'housekeeping_state', 'last_errors_json')) {
    db.exec(`ALTER TABLE housekeeping_state ADD COLUMN last_errors_json TEXT`);
  }

  // D-136 P2 — additive migration for the daily-token-budget +
  // cascade-budget knobs (housekeeping_config) and the per-task token
  // counters + budget-window-start (housekeeping_state). The columns
  // sit unread until P5 wires the walk-cap budget mechanism; defaults
  // mirror the CREATE TABLE DEFAULT values so a legacy-schema dev DB
  // post-migration matches a fresh-create DB. P5 will add a write path.
  if (!hasColumn(db, 'housekeeping_config', 'daily_token_budget_free')) {
    db.exec(
      `ALTER TABLE housekeeping_config
         ADD COLUMN daily_token_budget_free INTEGER NOT NULL DEFAULT ${D136_DEFAULT_DAILY_TOKEN_BUDGET_FREE}`,
    );
  }
  if (!hasColumn(db, 'housekeeping_config', 'daily_token_budget_byok')) {
    db.exec(
      `ALTER TABLE housekeeping_config
         ADD COLUMN daily_token_budget_byok INTEGER NOT NULL DEFAULT ${D136_DEFAULT_DAILY_TOKEN_BUDGET_BYOK}`,
    );
  }
  if (!hasColumn(db, 'housekeeping_config', 'cascade_budget_per_second_per_identity')) {
    db.exec(
      `ALTER TABLE housekeeping_config
         ADD COLUMN cascade_budget_per_second_per_identity INTEGER NOT NULL DEFAULT ${D136_DEFAULT_CASCADE_BUDGET_PER_SECOND_PER_IDENTITY}`,
    );
  }
  if (!hasColumn(db, 'housekeeping_config', 'cascade_queue_depth_max_per_topic')) {
    db.exec(
      `ALTER TABLE housekeeping_config
         ADD COLUMN cascade_queue_depth_max_per_topic INTEGER NOT NULL DEFAULT ${D136_DEFAULT_CASCADE_QUEUE_DEPTH_MAX_PER_TOPIC}`,
    );
  }
  if (!hasColumn(db, 'housekeeping_state', 'tokens_consumed_today_free')) {
    db.exec(
      `ALTER TABLE housekeeping_state
         ADD COLUMN tokens_consumed_today_free INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!hasColumn(db, 'housekeeping_state', 'tokens_consumed_today_byok')) {
    db.exec(
      `ALTER TABLE housekeeping_state
         ADD COLUMN tokens_consumed_today_byok INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!hasColumn(db, 'housekeeping_state', 'budget_window_start')) {
    db.exec(
      `ALTER TABLE housekeeping_state ADD COLUMN budget_window_start INTEGER`,
    );
  }
};
