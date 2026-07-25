/** D-120 Phase 1 — recipe_insights + links schema migration tests.
 *
 *  Covers:
 *    - Both new tables are created with the expected columns
 *    - Indexes are present on both tables + on audit_entries for the
 *      new output_string + recipe_insight_id surfaces
 *    - ensureMemorySchema is idempotent (safe at every boot)
 *    - recipe_insights.hash is UNIQUE (content-addressed)
 *    - links.kind enforces the LinkKind taxonomy via CHECK
 *    - links.recipe_insight_id has a FK pointing at recipe_insights.id
 *    - getOrCreateRecipeInsight returns the same id for the same hash
 *      across repeat calls + concurrent inserts
 *    - The composite PK on links keeps repeated emissions distinct
 *      when ts differs and dedupes within the same ts
 */

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { LINK_KINDS } from '@recued/contracts';
import {
  AuditEntry,
  ActivityEntry,
  type AuditLogStore,
  createAuditLogStore,
} from '@recued/storage';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { ensureAuditIndexes } from '../audit-indexes.js';
import {
  ensureMemorySchema,
  getOrCreateRecipeInsight,
} from '../memory-schema.js';

const makeDb = (): Database.Database => {
  const db = new Database(':memory:');
  // FK enforcement is opt-in per connection in SQLite.
  db.pragma('foreign_keys = ON');
  // The audit JSON-blob tables must exist before ensureAuditIndexes /
  // ensureMemorySchema run (json_extract indexes presume them).
  createSQLiteCollection<AuditEntry>(db, 'audit_entries');
  createSQLiteCollection<ActivityEntry>(db, 'audit_activities');
  ensureAuditIndexes(db);
  ensureMemorySchema(db);
  return db;
};

const tableNames = (db: Database.Database): Set<string> =>
  new Set(
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  );

const indexNames = (db: Database.Database): Set<string> =>
  new Set(
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  );

describe('ensureMemorySchema — table + index creation', () => {
  it('creates recipe_insights with the expected column set', () => {
    const db = makeDb();
    const cols = (
      db.prepare(`PRAGMA table_info(recipe_insights)`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>
    ).map((c) => c.name);
    // D-120 Phase 7.5 — bistemporal `event_at` column landed alongside
    // the original five.
    expect(cols).toEqual(['id', 'hash', 'slug', 'version', 'flattened', 'created_at', 'event_at']);
    db.close();
  });

  it('creates links with the expected column set + composite PK', () => {
    const db = makeDb();
    const info = db.prepare(`PRAGMA table_info(links)`).all() as Array<{
      name: string;
      pk: number;
    }>;
    const cols = info.map((c) => c.name);
    // D-120 Phase 7.5 — bistemporal `event_at` lands as the sixth column.
    // D-161 P1 — `origin_actor` / `origin_contract_id` provenance facet
    // columns follow (stamped on every D-120 provenance link, I-5).
    expect(cols).toEqual([
      'memory_id',
      'entity_id',
      'recipe_insight_id',
      'kind',
      'ts',
      'event_at',
      'origin_actor',
      'origin_contract_id',
    ]);
    // Composite PK (memory_id, entity_id, kind, ts) — pk=0 means
    // not-PK; non-zero columns indicate the PK position.
    const pkCols = info.filter((c) => c.pk > 0).map((c) => c.name);
    expect(new Set(pkCols)).toEqual(
      new Set(['memory_id', 'entity_id', 'kind', 'ts']),
    );
    db.close();
  });

  it('installs every documented index', () => {
    const db = makeDb();
    const names = indexNames(db);
    expect(names.has('idx_recipe_insights_slug_version')).toBe(true);
    expect(names.has('idx_links_entity_ts')).toBe(true);
    expect(names.has('idx_links_recipe_insight')).toBe(true);
    expect(names.has('idx_links_memory')).toBe(true);
    // audit_entries indexes for the new output_string + recipe_insight_id
    // surfaces ride on the same ensureMemorySchema call.
    expect(names.has('audit_entries_output_string_idx')).toBe(true);
    expect(names.has('audit_entries_recipe_insight_id_idx')).toBe(true);
    // D-153 P1 — three-tier session ID indexes. Engine writes the
    // fields starting in D-145; the indexes ride the same
    // ensureMemorySchema call so they're present from the substrate
    // slice forward.
    expect(names.has('audit_entries_channel_session_id_idx')).toBe(true);
    expect(names.has('audit_entries_cognition_session_id_idx')).toBe(true);
    expect(names.has('audit_entries_correlation_id_idx')).toBe(true);
    db.close();
  });

  it('is idempotent — second invocation is a no-op', () => {
    const db = makeDb();
    expect(() => ensureMemorySchema(db)).not.toThrow();
    expect(tableNames(db).has('recipe_insights')).toBe(true);
    expect(tableNames(db).has('links')).toBe(true);
    db.close();
  });
});

describe('recipe_insights — content-addressing constraints', () => {
  it('enforces UNIQUE on hash', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO recipe_insights (hash, slug, version, flattened, created_at)
         VALUES (?, ?, ?, ?, ?)`,
    ).run('hash-1', 'slug-1', 1, '{}', 100);
    expect(() =>
      db
        .prepare(
          `INSERT INTO recipe_insights (hash, slug, version, flattened, created_at)
             VALUES (?, ?, ?, ?, ?)`,
        )
        .run('hash-1', 'slug-2', 2, '{"steps":[]}', 200),
    ).toThrow(/UNIQUE/);
    db.close();
  });

  it('getOrCreateRecipeInsight returns the same id for the same hash', () => {
    const db = makeDb();
    const insight = {
      hash: 'hash-stable',
      slug: 'detect-deal-risk-hubspot',
      version: 3,
      flattened: '{"steps":[]}',
      created_at: 1000,
    };
    const id1 = getOrCreateRecipeInsight(db, insight);
    const id2 = getOrCreateRecipeInsight(db, insight);
    expect(id1).toBe(id2);
    // Re-call with a *different* slug under the same hash — content-
    // addressing wins, the original row is preserved untouched.
    const id3 = getOrCreateRecipeInsight(db, {
      ...insight,
      slug: 'something-else',
    });
    expect(id3).toBe(id1);
    const row = db
      .prepare(`SELECT slug, version FROM recipe_insights WHERE id = ?`)
      .get(id1) as { slug: string; version: number };
    expect(row.slug).toBe('detect-deal-risk-hubspot');
    expect(row.version).toBe(3);
    db.close();
  });

  it('idx_recipe_insights_slug_version covers the slug+version lookup', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO recipe_insights (hash, slug, version, flattened, created_at)
         VALUES (?, ?, ?, ?, ?)`,
    ).run('h1', 'recipe-a', 1, '{}', 100);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
           SELECT id FROM recipe_insights WHERE slug = ? AND version = ?`,
      )
      .all('recipe-a', 1) as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join('\n')).toMatch(
      /idx_recipe_insights_slug_version/,
    );
    db.close();
  });
});

describe('links — taxonomy + FK + composite PK', () => {
  const seedInsight = (db: Database.Database, hash = 'h1'): number =>
    getOrCreateRecipeInsight(db, {
      hash,
      slug: 's',
      version: 1,
      flattened: '{}',
      created_at: 1,
    });

  it('CHECK constraint rejects unknown LinkKind values', () => {
    const db = makeDb();
    const insightId = seedInsight(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO links (memory_id, entity_id, recipe_insight_id, kind, ts)
             VALUES (?, ?, ?, ?, ?)`,
        )
        .run('m1', 'e1', insightId, 'execution.unknown', 100),
    ).toThrow(/CHECK/);
    db.close();
  });

  it('CHECK constraint accepts every defined LinkKind', () => {
    const db = makeDb();
    const insightId = seedInsight(db);
    for (const kind of LINK_KINDS) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO links (memory_id, entity_id, recipe_insight_id, kind, ts)
               VALUES (?, ?, ?, ?, ?)`,
          )
          .run('m1', 'e1', insightId, kind, LINK_KINDS.indexOf(kind) + 1),
      ).not.toThrow();
    }
    const total = (
      db.prepare(`SELECT COUNT(*) AS c FROM links`).get() as { c: number }
    ).c;
    expect(total).toBe(LINK_KINDS.length);
    db.close();
  });

  it('foreign key on recipe_insight_id rejects orphan inserts', () => {
    const db = makeDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO links (memory_id, entity_id, recipe_insight_id, kind, ts)
             VALUES (?, ?, ?, ?, ?)`,
        )
        .run('m1', 'e1', 9999, 'execution.action', 100),
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('composite PK keeps distinct ts apart but dedupes same-ts rows', () => {
    const db = makeDb();
    const insightId = seedInsight(db);
    const insert = db.prepare(
      `INSERT INTO links (memory_id, entity_id, recipe_insight_id, kind, ts)
         VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run('m1', 'e1', insightId, 'execution.action', 100);
    insert.run('m1', 'e1', insightId, 'execution.action', 101);
    insert.run('m1', 'e1', insightId, 'execution.action', 102);
    expect(() =>
      insert.run('m1', 'e1', insightId, 'execution.action', 100),
    ).toThrow(/UNIQUE|PRIMARY KEY/);
    const rows = db
      .prepare(
        `SELECT ts FROM links WHERE memory_id = ? AND entity_id = ? ORDER BY ts`,
      )
      .all('m1', 'e1') as Array<{ ts: number }>;
    expect(rows.map((r) => r.ts)).toEqual([100, 101, 102]);
    db.close();
  });

  it('idx_links_entity_ts covers entity-keyed range scans', () => {
    const db = makeDb();
    const insightId = seedInsight(db);
    db.prepare(
      `INSERT INTO links (memory_id, entity_id, recipe_insight_id, kind, ts)
         VALUES (?, ?, ?, ?, ?)`,
    ).run('m1', 'deal:hubspot-42', insightId, 'execution.action', 100);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
           SELECT memory_id FROM links WHERE entity_id = ? ORDER BY ts DESC`,
      )
      .all('deal:hubspot-42') as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join('\n')).toMatch(/idx_links_entity_ts/);
    db.close();
  });
});

describe('audit_entries — output_string + recipe_insight_id surface', () => {
  let db: Database.Database;
  let store: AuditLogStore;
  beforeEach(() => {
    db = makeDb();
    store = createAuditLogStore(
      createSQLiteCollection<AuditEntry>(db, 'audit_entries'),
      createSQLiteCollection<ActivityEntry>(db, 'audit_activities'),
    );
  });

  it('AuditEntry round-trips the new optional fields through the store', async () => {
    const entry: AuditEntry = {
      run_id: 'r-1',
      recipe_id: 'recipe-x',
      recipe_hash: 'hash-x',
      started_at: 100,
      finished_at: 200,
      duration_ms: 100,
      commit_status: 'succeeded',
      config_snapshot: {},
      errors: [],
      trigger_url: null,
      trigger_source: null,
      instance_id: null,
      output_string: 'approval:allow',
      recipe_insight_id: 42,
    };
    await store.append(entry);
    const fetched = await store.get('r-1');
    expect(fetched?.output_string).toBe('approval:allow');
    expect(fetched?.recipe_insight_id).toBe(42);
    db.close();
  });

  it('audit_entries_recipe_insight_id_idx covers insight-keyed queries', () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
           SELECT key FROM audit_entries
            WHERE json_extract(data, '$.recipe_insight_id') = 42
            ORDER BY json_extract(data, '$.started_at') DESC`,
      )
      .all() as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join('\n')).toMatch(
      /audit_entries_recipe_insight_id_idx/,
    );
    db.close();
  });
});
