/** The audit byte counter equals the sum it replaces, through every path.
 *
 *  ⛔ WHY EQUIVALENCE IS THE WHOLE TEST. The counter decides when the audit
 *  size-prune pass fires. Drift LOW disables pruning silently and the log grows
 *  past its quota; drift HIGH prunes early on a surface that evicts
 *  oldest-first, which is data loss. "It's faster" is worth nothing if the
 *  number moved.
 *
 *  ⛔ AND THE PATHS THAT MATTER ARE THE ONES THAT BYPASS THE STORE. The storage
 *  gate's existing total is wrong today precisely because
 *  `audit-compaction.ts` issues a raw `DELETE FROM audit_entries` and never
 *  reports it. So the cases below mutate the tables DIRECTLY — raw INSERT, raw
 *  DELETE, raw UPDATE, `INSERT OR REPLACE`, and a rollback — because a counter
 *  that only works when called politely is the design that already failed here.
 *
 *  ⚠ `length()` counts CHARACTERS, not bytes. That is what the quota has always
 *  meant, so the assertions compare against `SUM(length(data))` and NOT against
 *  a byte length — pinning the measure, not just the arithmetic. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ensureAuditIndexes } from '../audit-indexes.js';
import {
  ensureAuditUsageCounter,
  readAuditUsageBytes,
  recomputeAuditUsageBytes,
} from '../audit-usage-counter.js';

const mk = (seedRows = 0): Database.Database => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE audit_entries    (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE audit_activities (key TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  // Rows written BEFORE the migration, so the seed path is exercised rather
  // than only the trigger path — that is the shape every existing install has.
  const ins = db.prepare('INSERT INTO audit_entries (key, data) VALUES (?, ?)');
  for (let i = 0; i < seedRows; i++) ins.run(`pre-${i}`, JSON.stringify({ i, pad: 'x'.repeat(50) }));
  ensureAuditIndexes(db);
  return db;
};

/** The invariant, asserted after every mutation: the counter IS the sum. */
const expectAgrees = (db: Database.Database, label: string): void => {
  expect(readAuditUsageBytes(db), label).toBe(recomputeAuditUsageBytes(db));
};

describe('audit usage counter', () => {
  it('⛔ seeds from existing rows — an upgraded install is not counted as empty', () => {
    const db = mk(200);
    expect(readAuditUsageBytes(db)).toBeGreaterThan(0);
    expectAgrees(db, 'after migration on a populated db');
    db.close();
  });

  it('⛔ tracks raw INSERT / UPDATE / DELETE that never touch the store', () => {
    const db = mk(10);
    const ins = db.prepare('INSERT INTO audit_entries (key, data) VALUES (?, ?)');
    const act = db.prepare('INSERT INTO audit_activities (key, data) VALUES (?, ?)');

    for (let i = 0; i < 50; i++) ins.run(`e-${i}`, JSON.stringify({ i, pad: 'y'.repeat(i) }));
    expectAgrees(db, 'after raw inserts into audit_entries');

    for (let i = 0; i < 30; i++) act.run(`a-${i}`, JSON.stringify({ i, pad: 'z'.repeat(i) }));
    expectAgrees(db, 'after raw inserts into audit_activities');

    // The compaction shape: a raw DELETE that bypasses the store entirely.
    db.prepare(`DELETE FROM audit_entries WHERE key = ?`).run('e-7');
    db.prepare(`DELETE FROM audit_entries WHERE key LIKE 'e-1%'`).run();
    expectAgrees(db, 'after raw deletes');

    db.prepare(`UPDATE audit_entries SET data = ? WHERE key = ?`)
      .run(JSON.stringify({ replaced: true, pad: 'w'.repeat(500) }), 'e-3');
    expectAgrees(db, 'after a raw UPDATE that GROWS a row');

    db.prepare(`UPDATE audit_entries SET data = ? WHERE key = ?`).run('{}', 'e-3');
    expectAgrees(db, 'after a raw UPDATE that SHRINKS a row');

    // `INSERT OR REPLACE` fires DELETE-then-INSERT; both deltas must land.
    db.prepare(`INSERT OR REPLACE INTO audit_entries (key, data) VALUES (?, ?)`)
      .run('e-4', JSON.stringify({ pad: 'q'.repeat(300) }));
    expectAgrees(db, 'after INSERT OR REPLACE');

    db.close();
  });

  it('⛔ a ROLLED-BACK write rolls back its delta too', () => {
    // The property that makes this exact rather than eventually-consistent.
    // A counter maintained in JS after the write would keep the bytes of a
    // transaction the database threw away.
    const db = mk(5);
    const before = readAuditUsageBytes(db);
    const ins = db.prepare('INSERT INTO audit_entries (key, data) VALUES (?, ?)');
    expect(() => {
      db.transaction(() => {
        for (let i = 0; i < 20; i++) ins.run(`roll-${i}`, JSON.stringify({ pad: 'r'.repeat(100) }));
        throw new Error('abort');
      })();
    }).toThrow('abort');
    expect(readAuditUsageBytes(db)).toBe(before);
    expectAgrees(db, 'after rollback');
    db.close();
  });

  it('⛔ counts CHARACTERS, matching the measure the quota was calibrated on', () => {
    // `length(x)` is characters; `length(CAST(x AS BLOB))` is bytes. For
    // multi-byte content they differ, and switching would silently re-scale
    // every existing server's effective audit quota.
    const db = mk();
    const multibyte = JSON.stringify({ note: 'héllo€ — 汉字' });
    db.prepare('INSERT INTO audit_entries (key, data) VALUES (?, ?)').run('m', multibyte);

    const chars = (db.prepare('SELECT length(data) c FROM audit_entries').get() as { c: number }).c;
    const bytes = (db.prepare('SELECT length(CAST(data AS BLOB)) c FROM audit_entries')
      .get() as { c: number }).c;
    expect(bytes).toBeGreaterThan(chars); // else the case is vacuous
    expect(readAuditUsageBytes(db)).toBe(chars);
    db.close();
  });

  it('⛔ reads O(1) — the plan must not scan the audit tables', () => {
    // The whole point. A correct answer computed by scanning is the defect
    // this replaced, and only the plan can tell them apart.
    const db = mk(100);
    const plan = (db
      .prepare(`EXPLAIN QUERY PLAN SELECT bytes FROM audit_usage WHERE surface = ?`)
      .all('audit') as Array<{ detail: string }>).map((r) => r.detail).join(' ; ');
    expect(plan).not.toMatch(/audit_entries|audit_activities/);
    expect(plan).toMatch(/audit_usage/);
    db.close();
  });

  it('is idempotent — a second migration does not double-count', () => {
    const db = mk(50);
    const once = readAuditUsageBytes(db);
    ensureAuditIndexes(db);
    ensureAuditIndexes(db);
    expect(readAuditUsageBytes(db)).toBe(once);
    expectAgrees(db, 'after repeated migration');
    db.close();
  });

  it('⛔ RATCHET: the collection insert stays OR REPLACE, never OR IGNORE', () => {
    // The BEFORE INSERT trigger nets out the row it replaces. That is exact for
    // INSERT and INSERT OR REPLACE, and WRONG for a strategy that fires the
    // trigger and then skips the insert (`OR IGNORE`, `ON CONFLICT DO
    // NOTHING`), which would leave `-OLD` behind and drift the counter LOW —
    // silently disabling the size-prune pass. The audit tables reach SQL only
    // through `createSQLiteCollection`, so pinning its one insert pins the
    // whole surface.
    const fs = require('node:fs') as typeof import('node:fs');
    const src = fs.readFileSync(
      new URL('../sqlite-collection.ts', import.meta.url), 'utf8',
    );
    const inserts = [...src.matchAll(/INSERT[^`]*?INTO \$\{table\}/g)].map((m) => m[0]);
    expect(inserts.length, 'no insert found — the ratchet would be vacuous')
      .toBeGreaterThan(0);
    for (const stmt of inserts) {
      expect(stmt, 'audit counter assumes OR REPLACE').toMatch(/INSERT OR REPLACE/);
      expect(stmt).not.toMatch(/OR IGNORE|ON CONFLICT/i);
    }
  });

  it('⛔ an ephemeral server with NO audit tables returns 0, never throws', () => {
    // `computeInitialUsage` documents this contract — "Conservative: missing
    // tables return 0 (e.g. an ephemeral server without an audit log)" — and
    // the first cut of this module broke it. The throw surfaced twice, far from
    // its cause: as a boot failure in the gate, and as a retention tick that
    // silently did nothing inside its own catch.
    // ⚠ `ensureAuditUsageCounter`, not `ensureAuditIndexes` — the latter
    // creates indexes ON the audit tables and has ALWAYS required them. Only
    // the counter claims to tolerate their absence, so only it is asserted.
    const bare = new Database(':memory:');
    expect(() => ensureAuditUsageCounter(bare)).not.toThrow();
    expect(readAuditUsageBytes(bare)).toBe(0);
    expect(recomputeAuditUsageBytes(bare)).toBe(0);
    bare.close();

    // ...and with the audit tables present but the counter table absent, the
    // answer is the real total rather than 0.
    const noCounter = new Database(':memory:');
    noCounter.exec(`
      CREATE TABLE audit_entries    (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE audit_activities (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      INSERT INTO audit_entries VALUES ('a', '0123456789');
    `);
    expect(readAuditUsageBytes(noCounter)).toBe(10);
    noCounter.close();
  });

  it('falls back to the authoritative sum if the counter row is missing', () => {
    // A zero here would read as "well under quota" and silently disable the
    // size-prune pass, so absence must NOT resolve to zero.
    const db = mk(20);
    db.prepare(`DELETE FROM audit_usage WHERE surface = 'audit'`).run();
    expect(readAuditUsageBytes(db)).toBe(recomputeAuditUsageBytes(db));
    expect(readAuditUsageBytes(db)).toBeGreaterThan(0);
    db.close();
  });
});
