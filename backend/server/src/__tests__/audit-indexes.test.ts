import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { ensureAuditIndexes } from '../audit-indexes.js';
import type { AuditEntry, ActivityEntry } from '@recued/storage';

const makeDb = (): Database.Database => {
  const db = new Database(':memory:');
  // Collections must be created first — ensureAuditIndexes presumes the
  // tables already exist (otherwise CREATE INDEX fails even with
  // IF NOT EXISTS).
  createSQLiteCollection<AuditEntry>(db, 'audit_entries');
  createSQLiteCollection<ActivityEntry>(db, 'audit_activities');
  return db;
};

describe('ensureAuditIndexes', () => {
  it('creates the expected json_extract indexes on both tables', () => {
    const db = makeDb();
    ensureAuditIndexes(db);
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'audit_%'`,
      )
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    expect(names.has('audit_entries_reserve_idx')).toBe(true);
    expect(names.has('audit_entries_started_at_idx')).toBe(true);
    expect(names.has('audit_activities_reserve_idx')).toBe(true);
    expect(names.has('audit_activities_timestamp_idx')).toBe(true);
    db.close();
  });

  it('is idempotent — calling twice does not throw', () => {
    const db = makeDb();
    ensureAuditIndexes(db);
    expect(() => ensureAuditIndexes(db)).not.toThrow();
    db.close();
  });

  it('indexes resolve reserve predicates without a full-table parse', () => {
    const db = makeDb();
    ensureAuditIndexes(db);
    // EXPLAIN QUERY PLAN should show an index lookup — the exact plan
    // text depends on SQLite version, so just assert it mentions one
    // of our audit indexes.
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT key FROM audit_entries
         WHERE json_extract(data, '$.reserve') = 1`,
      )
      .all() as Array<{ detail: string }>;
    const planText = plan.map((r) => r.detail).join('\n');
    expect(planText).toMatch(/audit_entries_reserve_idx/);
    db.close();
  });

  it('created before writes arrive — first insert lands in indexed table', () => {
    const db = makeDb();
    ensureAuditIndexes(db);
    // Insert a reserve row and confirm the index can locate it.
    db.prepare(
      `INSERT INTO audit_entries (key, data) VALUES (?, ?)`,
    ).run(
      'r1',
      JSON.stringify({
        run_id: 'r1',
        started_at: 100,
        reserve: true,
      }),
    );
    const hit = db
      .prepare(
        `SELECT key FROM audit_entries
         WHERE json_extract(data, '$.reserve') = 1`,
      )
      .all() as Array<{ key: string }>;
    expect(hit.map((r) => r.key)).toEqual(['r1']);
    db.close();
  });
});
