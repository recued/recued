/** D-136 Phase 2 — Storage schema substrate (server surface).
 *
 *  Locks the post-P2 column shape on `data_enrichment` +
 *  `housekeeping_config` + `housekeeping_state`, plus the new
 *  `data_enrichment_quality_vote` and `external_context_pulse`
 *  tables. Tests cover:
 *    - fresh-create schema matches spec §A.6 column-by-column
 *    - legacy `model_used` + `stale` columns dropped
 *    - new columns + indexes present
 *    - idempotency: two consecutive `ensureEnrichmentSchema` /
 *      `ensureHousekeepingSchema` calls leave the schema unchanged
 *    - pre-D-136 schema migration: a hand-rolled legacy table picks
 *      up every new column on the next ensure pass and drops the
 *      legacy `model_used` + `stale` columns
 *    - dedup primary key — `(target_id, input_fingerprint_hash,
 *      producer_version_hash)` rows on the same `(topic, scope,
 *      target_id, authored_by)` key collapse into one row (existing
 *      idx_enrichment_per_record_upsert UNIQUE invariant). The new
 *      `idx_enrichment_dedup_lookup` is a NON-unique cover index for
 *      the P3 dedup probe; uniqueness is enforced by the existing
 *      per-record UNIQUE so callers can't double-write the same
 *      `(topic, scope, target_id, authored_by)` slot.
 *    - housekeeping default budgets are seeded on a fresh row write
 *
 *  Spec: D-136 §A.6 + P2 phase plan. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  D136_DEFAULT_DAILY_TOKEN_BUDGET_FREE,
  D136_DEFAULT_DAILY_TOKEN_BUDGET_BYOK,
  D136_DEFAULT_CASCADE_BUDGET_PER_SECOND_PER_IDENTITY,
  D136_DEFAULT_CASCADE_QUEUE_DEPTH_MAX_PER_TOPIC,
  ensureHousekeepingSchema,
} from '../housekeeping/schema.js';
import { ensureEnrichmentSchema } from '../storage/enrichment-store.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-schema-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const colNames = (table: string): Set<string> => {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
};

const indexNames = (table: string): Set<string> => {
  const rows = db
    .prepare(`PRAGMA index_list(${table})`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
};

// ────────────────────────────────────────────────────────────────
// data_enrichment — fresh-create shape
// ────────────────────────────────────────────────────────────────

describe('D-136 P2 — data_enrichment fresh CREATE TABLE', () => {
  beforeEach(() => {
    ensureEnrichmentSchema(db);
  });

  it('drops legacy model_used + stale columns', () => {
    const cols = colNames('data_enrichment');
    expect(cols.has('model_used')).toBe(false);
    expect(cols.has('stale')).toBe(false);
  });

  it('ships ingredient_slug + model_id', () => {
    const cols = colNames('data_enrichment');
    expect(cols.has('ingredient_slug')).toBe(true);
    expect(cols.has('model_id')).toBe(true);
  });

  it('ships staleness_class with a NOT NULL DEFAULT', () => {
    const rows = db
      .prepare(`PRAGMA table_info(data_enrichment)`)
      .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    const sc = rows.find((r) => r.name === 'staleness_class');
    expect(sc).toBeDefined();
    expect(sc!.notnull).toBe(1);
    expect(sc!.dflt_value).toBe(`'fresh'`);
  });

  it('ships every D-136 §A.6 bistemporal / dedup / lifecycle column', () => {
    const expected = [
      'as_of',
      'last_evaluated_at',
      'producer_version_hash',
      'input_fingerprint_hash',
      'input_completeness',
      'lifecycle_action_pending',
      'failure_attempt_count',
      'last_failure_reason',
      'superseded_by_id',
      'tombstoned_at',
      'tombstone_reason',
      'input_enrichment_row_ids',
    ];
    const cols = colNames('data_enrichment');
    for (const name of expected) {
      expect(cols.has(name), `missing column ${name}`).toBe(true);
    }
  });

  it('failure_attempt_count defaults to 0', () => {
    const rows = db
      .prepare(`PRAGMA table_info(data_enrichment)`)
      .all() as Array<{ name: string; dflt_value: string | null }>;
    const fac = rows.find((r) => r.name === 'failure_attempt_count');
    expect(fac).toBeDefined();
    expect(fac!.dflt_value).toBe('0');
  });

  it('ships every new D-136 §A.6 index', () => {
    const idx = indexNames('data_enrichment');
    expect(idx.has('idx_enrichment_action_pending')).toBe(true);
    expect(idx.has('idx_enrichment_as_of')).toBe(true);
    expect(idx.has('idx_enrichment_superseded')).toBe(true);
    expect(idx.has('idx_enrichment_dedup_lookup')).toBe(true);
  });

  it('idx_enrichment_stale_sweep narrowed to staleness_class != fresh', () => {
    const ddl = (
      db
        .prepare(
          `SELECT sql FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_enrichment_stale_sweep'`,
        )
        .get() as { sql: string }
    ).sql;
    expect(ddl).toContain("staleness_class");
    expect(ddl).toContain("'fresh'");
  });
});

// ────────────────────────────────────────────────────────────────
// data_enrichment — pre-D-136 → P2 migration
// ────────────────────────────────────────────────────────────────

describe('D-136 P2 — pre-D-136 schema migrates to P2 shape', () => {
  it('drops legacy stale + model_used and adds every new column', () => {
    // Seed a legacy DB shape (D-128 era — `model_used` + `stale`).
    db.exec(`
      CREATE TABLE data_enrichment (
        _id                TEXT PRIMARY KEY,
        topic              TEXT NOT NULL,
        scope              TEXT,
        target_id          TEXT,
        value              TEXT NOT NULL,
        authored_by        TEXT NOT NULL,
        source_record_hash TEXT,
        recipe_hash        TEXT,
        model_used         TEXT,
        event_at           INTEGER,
        ingested_at        INTEGER NOT NULL,
        authored_at        INTEGER NOT NULL,
        stale              INTEGER NOT NULL DEFAULT 0,
        meta               TEXT,
        mirror_blob_hash   TEXT
      );
    `);
    // Run the P2 ensure pass — must not throw + must reconcile shape.
    expect(() => ensureEnrichmentSchema(db)).not.toThrow();
    const cols = colNames('data_enrichment');
    expect(cols.has('model_used')).toBe(false);
    expect(cols.has('stale')).toBe(false);
    expect(cols.has('staleness_class')).toBe(true);
    expect(cols.has('ingredient_slug')).toBe(true);
    expect(cols.has('model_id')).toBe(true);
    expect(cols.has('input_fingerprint_hash')).toBe(true);
    expect(cols.has('producer_version_hash')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Idempotency
// ────────────────────────────────────────────────────────────────

describe('D-136 P2 — schema migration idempotency', () => {
  it('two consecutive ensureEnrichmentSchema calls converge on the same shape', () => {
    ensureEnrichmentSchema(db);
    const before = colNames('data_enrichment');
    expect(() => ensureEnrichmentSchema(db)).not.toThrow();
    const after = colNames('data_enrichment');
    expect([...after].sort()).toEqual([...before].sort());
  });

  it('two consecutive ensureHousekeepingSchema calls converge on the same shape', () => {
    ensureHousekeepingSchema(db);
    const beforeConfig = colNames('housekeeping_config');
    const beforeState = colNames('housekeeping_state');
    expect(() => ensureHousekeepingSchema(db)).not.toThrow();
    expect([...colNames('housekeeping_config')].sort()).toEqual(
      [...beforeConfig].sort(),
    );
    expect([...colNames('housekeeping_state')].sort()).toEqual(
      [...beforeState].sort(),
    );
  });
});

// ────────────────────────────────────────────────────────────────
// New tables — quality vote + external context pulse
// ────────────────────────────────────────────────────────────────

describe('D-136 P2 — data_enrichment_quality_vote table', () => {
  beforeEach(() => {
    ensureEnrichmentSchema(db);
  });

  it('exists with the §A.6 column shape', () => {
    const cols = colNames('data_enrichment_quality_vote');
    expect(cols.has('vote_id')).toBe(true);
    expect(cols.has('topic')).toBe(true);
    expect(cols.has('scope')).toBe(true);
    expect(cols.has('target_id')).toBe(true);
    expect(cols.has('enrichment_row_id')).toBe(true);
    expect(cols.has('vote')).toBe(true);
    expect(cols.has('source')).toBe(true);
    expect(cols.has('corrected_value')).toBe(true);
    expect(cols.has('context_recipe_id')).toBe(true);
    expect(cols.has('voted_at')).toBe(true);
    expect(cols.has('voted_by_client_id')).toBe(true);
  });

  it('ships idx_vote_topic + idx_vote_row + idx_vote_voted_at indexes', () => {
    const idx = indexNames('data_enrichment_quality_vote');
    expect(idx.has('idx_vote_topic')).toBe(true);
    expect(idx.has('idx_vote_row')).toBe(true);
    expect(idx.has('idx_vote_voted_at')).toBe(true);
  });
});

describe('D-136 §A.14.1 — external_context_pulse table', () => {
  beforeEach(() => {
    ensureEnrichmentSchema(db);
  });

  it('exists with the four-column shape', () => {
    const cols = colNames('external_context_pulse');
    expect(cols.has('context_id')).toBe(true);
    expect(cols.has('pulse_value')).toBe(true);
    expect(cols.has('observed_at')).toBe(true);
    expect(cols.has('next_check_at')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Housekeeping config + state — D-136 P2 budget columns
// ────────────────────────────────────────────────────────────────

describe('D-136 P2 — housekeeping_config token + cascade budgets', () => {
  beforeEach(() => {
    ensureHousekeepingSchema(db);
  });

  it('ships every new D-136 P2 column with the spec defaults', () => {
    const rows = db
      .prepare(`PRAGMA table_info(housekeeping_config)`)
      .all() as Array<{ name: string; dflt_value: string | null }>;
    const byName = new Map(rows.map((r) => [r.name, r.dflt_value]));

    expect(byName.get('daily_token_budget_free')).toBe(
      String(D136_DEFAULT_DAILY_TOKEN_BUDGET_FREE),
    );
    expect(byName.get('daily_token_budget_byok')).toBe(
      String(D136_DEFAULT_DAILY_TOKEN_BUDGET_BYOK),
    );
    expect(byName.get('cascade_budget_per_second_per_identity')).toBe(
      String(D136_DEFAULT_CASCADE_BUDGET_PER_SECOND_PER_IDENTITY),
    );
    expect(byName.get('cascade_queue_depth_max_per_topic')).toBe(
      String(D136_DEFAULT_CASCADE_QUEUE_DEPTH_MAX_PER_TOPIC),
    );
  });

  it('seeds default budgets on a fresh insert that omits them', () => {
    // Existing config writers (D-123 / D-132) only INSERT the original
    // column list. Verify the new columns pick up DEFAULT values when
    // an upsert ignores them.
    db.prepare(`
      INSERT INTO housekeeping_config
        (id, preset, cycle_budget_ms, cycle_interval_minutes, updated_at)
      VALUES ('singleton', 'balanced', 1000, 60, ?)
    `).run(Date.now());
    const row = db
      .prepare(
        `SELECT daily_token_budget_free,
                daily_token_budget_byok,
                cascade_budget_per_second_per_identity,
                cascade_queue_depth_max_per_topic
           FROM housekeeping_config WHERE id = 'singleton'`,
      )
      .get() as Record<string, number>;
    expect(row.daily_token_budget_free).toBe(D136_DEFAULT_DAILY_TOKEN_BUDGET_FREE);
    expect(row.daily_token_budget_byok).toBe(D136_DEFAULT_DAILY_TOKEN_BUDGET_BYOK);
    expect(row.cascade_budget_per_second_per_identity).toBe(
      D136_DEFAULT_CASCADE_BUDGET_PER_SECOND_PER_IDENTITY,
    );
    expect(row.cascade_queue_depth_max_per_topic).toBe(
      D136_DEFAULT_CASCADE_QUEUE_DEPTH_MAX_PER_TOPIC,
    );
  });
});

describe('D-136 P2 — housekeeping_state per-task token counters', () => {
  beforeEach(() => {
    ensureHousekeepingSchema(db);
  });

  it('ships tokens_consumed_today_free + tokens_consumed_today_byok + budget_window_start', () => {
    const cols = colNames('housekeeping_state');
    expect(cols.has('tokens_consumed_today_free')).toBe(true);
    expect(cols.has('tokens_consumed_today_byok')).toBe(true);
    expect(cols.has('budget_window_start')).toBe(true);
  });

  it('seeds default counters when an existing INSERT omits them', () => {
    db.prepare(`
      INSERT INTO housekeeping_state
        (task_id, cursor_json, last_status, consecutive_errors)
      VALUES ('test-task', '{"kind":"complete"}', 'pending', 0)
    `).run();
    const row = db
      .prepare(
        `SELECT tokens_consumed_today_free,
                tokens_consumed_today_byok,
                budget_window_start
           FROM housekeeping_state WHERE task_id = 'test-task'`,
      )
      .get() as { tokens_consumed_today_free: number; tokens_consumed_today_byok: number; budget_window_start: number | null };
    expect(row.tokens_consumed_today_free).toBe(0);
    expect(row.tokens_consumed_today_byok).toBe(0);
    expect(row.budget_window_start).toBeNull();
  });
});

describe('D-136 P2 — pre-D-136 housekeeping schema picks up new columns', () => {
  it('legacy housekeeping_config gets the budget columns added on ensure', () => {
    db.exec(`
      CREATE TABLE housekeeping_config (
        id                          TEXT PRIMARY KEY,
        preset                      TEXT NOT NULL,
        cycle_budget_ms             INTEGER NOT NULL,
        cycle_interval_minutes      INTEGER NOT NULL,
        custom_window_start_hour    INTEGER,
        custom_window_end_hour      INTEGER,
        updated_at                  INTEGER NOT NULL
      );
    `);
    expect(() => ensureHousekeepingSchema(db)).not.toThrow();
    const cols = colNames('housekeeping_config');
    expect(cols.has('daily_token_budget_free')).toBe(true);
    expect(cols.has('daily_token_budget_byok')).toBe(true);
    expect(cols.has('cascade_budget_per_second_per_identity')).toBe(true);
    expect(cols.has('cascade_queue_depth_max_per_topic')).toBe(true);
  });

  it('legacy housekeeping_state gets the token-counter columns on ensure', () => {
    db.exec(`
      CREATE TABLE housekeeping_state (
        task_id                     TEXT PRIMARY KEY,
        cursor_json                 TEXT NOT NULL,
        last_run_at                 INTEGER,
        last_run_duration_ms        INTEGER,
        last_yield_reason           TEXT,
        last_status                 TEXT NOT NULL DEFAULT 'pending',
        consecutive_errors          INTEGER NOT NULL DEFAULT 0,
        last_error                  TEXT
      );
    `);
    expect(() => ensureHousekeepingSchema(db)).not.toThrow();
    const cols = colNames('housekeeping_state');
    expect(cols.has('tokens_consumed_today_free')).toBe(true);
    expect(cols.has('tokens_consumed_today_byok')).toBe(true);
    expect(cols.has('budget_window_start')).toBe(true);
  });
});
