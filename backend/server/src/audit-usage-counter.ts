/** An O(1) byte total for the audit surface, maintained by SQLite itself.
 *
 *  ⛔ THE PROBLEM. `audit-retention`'s hourly tick asked "am I over the prune
 *  trigger?" with `SUM(length(data))` across both audit tables — a full scan of
 *  the entire audit corpus, every hour, forever, and on a healthy server it
 *  reads everything to answer "no". Measured on the real statement:
 *
 *      rows        db        idle check
 *      1,000       1 MB        0.18 ms
 *      10,000      5 MB        1.89 ms
 *      100,000    51 MB       33.43 ms
 *      400,000   203 MB      124.35 ms      (linear in rows)
 *
 *  D-230 raised the audit quota to 5 GB, so the corpus this runs against
 *  settles in the millions of rows — seconds per tick — and that is before the
 *  rest of a real server's storage shares the same disk.
 *
 *  ⛔ WHY NOT JUST READ THE STORAGE GATE, which already tracks a live total.
 *  Two reasons, both fatal:
 *    1. CIRCULAR — the gate's `used` is re-anchored BY the very statement this
 *       would replace (`gate.setUsed(measureAuditUsage())`, unconditionally,
 *       every tick). Substituting it makes the trigger depend on a number only
 *       this tick corrects.
 *    2. IT DRIFTS HIGH — `housekeeping/tasks/audit-compaction.ts` DELETEs
 *       audit rows and never decrements the gate. Drift-high means pruning
 *       EARLY on a surface that evicts oldest-first: data loss, not overshoot.
 *
 *  🔑 SO THE COUNTER IS MAINTAINED BY TRIGGERS, NOT BY CALLERS. Every writer,
 *  every deleter, present and future — including the raw `DELETE FROM
 *  audit_entries` statements in the pruner and in compaction, which never went
 *  through the store — is covered, because the obligation lives in the schema
 *  rather than in a contract each caller has to remember. A caller-obligation
 *  design is exactly how the gate ended up wrong: one host forgot, and nothing
 *  below it failed.
 *
 *  ⚠ `length(data)` COUNTS CHARACTERS, NOT BYTES (`length(CAST(data AS BLOB))`
 *  is bytes; for `'héllo€'` they are 6 and 9). The quota has always been
 *  calibrated against the character count, so the triggers use the IDENTICAL
 *  expression. "Fixing" it to bytes here would silently re-scale every existing
 *  server's effective audit quota — a data-retention change wearing an
 *  accuracy fix's clothes.
 *
 *  ⚠ Triggers participate in the enclosing transaction, so a rolled-back write
 *  rolls back its delta too. That is the property that makes this exact rather
 *  than eventually-consistent. */

import type Database from 'better-sqlite3';

/** The single row's key. One surface today; the table is keyed so a second
 *  counted surface does not need a second table. */
export const AUDIT_USAGE_SURFACE = 'audit';

/** The authoritative measure — the statement the counter replaces. Kept because
 *  something has to seed the counter, and because a test that compares the
 *  counter against a re-derived truth needs the truth. */
const tableExists = (db: Database.Database, name: string): boolean =>
  db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) !== undefined;

export const recomputeAuditUsageBytes = (db: Database.Database): number => {
  // ⚠ A MISSING TABLE CONTRIBUTES 0, NEVER THROWS. `computeInitialUsage`
  // documents that contract — "Conservative: missing tables return 0 (e.g. an
  // ephemeral server without an audit log)" — and the first cut of this module
  // broke it: an ephemeral server, a pre-migration database and half the test
  // fixtures have no audit tables, and the throw surfaced as a boot failure and
  // as a retention tick that silently did nothing inside its own catch.
  let total = 0;
  for (const table of ['audit_entries', 'audit_activities']) {
    if (!tableExists(db, table)) continue;
    const row = db
      .prepare(`SELECT COALESCE(SUM(length(data)), 0) AS total FROM ${table}`)
      .get() as { total: number };
    total += row.total;
  }
  return total;
};

/** Create the counter + its triggers, and seed it from the authoritative sum.
 *
 *  ⚠ The seed scan runs ONCE, at schema creation — the cost this removes is the
 *  HOURLY repetition, not the single boot-time measurement (which
 *  `computeInitialUsage` already pays for the gate anyway).
 *
 *  ⛔ Idempotent, and safe to call on a database that already has rows: the
 *  `INSERT OR IGNORE` seeds only when the row is absent, so a second call never
 *  double-counts. Called from the same place the audit indexes are ensured, so
 *  an existing install picks it up on its next boot. */
export const ensureAuditUsageCounter = (db: Database.Database): void => {
  // ⛔ NO AUDIT TABLES, NO COUNTER. The triggers name those tables, so creating
  // them here would throw on an ephemeral server that has no audit log — and
  // `ensureAuditIndexes` is called from CLI contexts that may be exactly that.
  // The read path already handles the counter being absent.
  if (!tableExists(db, 'audit_entries') || !tableExists(db, 'audit_activities')) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_usage (
      surface TEXT PRIMARY KEY,
      bytes   INTEGER NOT NULL
    );
  `);

  // Seed BEFORE the triggers exist, so the seeding read cannot race its own
  // triggers, and so a partially-created schema never counts a row twice.
  const seeded = db
    .prepare(`SELECT COUNT(*) AS c FROM audit_usage WHERE surface = ?`)
    .get(AUDIT_USAGE_SURFACE) as { c: number };
  if (seeded.c === 0) {
    db.prepare(`INSERT INTO audit_usage (surface, bytes) VALUES (?, ?)`)
      .run(AUDIT_USAGE_SURFACE, recomputeAuditUsageBytes(db));
  }

  // ⛔ THE INSERT TRIGGER IS `BEFORE`, AND NETS OUT ANY ROW IT REPLACES.
  //
  // SQLite fires DELETE triggers for the row a REPLACE displaces ONLY when
  // `PRAGMA recursive_triggers` is on, and it is off by default. With a plain
  // AFTER INSERT trigger, `INSERT OR REPLACE` over an existing key therefore
  // ADDS the new row's length and never subtracts the old one — the counter
  // drifts HIGH, which is the dangerous direction: pruning early on a surface
  // that evicts oldest-first is data loss, not overshoot. Caught by the
  // equivalence test (3598 vs 3578), not by review.
  //
  // ⚠ Enabling `recursive_triggers` would fix it and is NOT done: it is a
  // connection-level pragma that would also change how the FTS sync triggers
  // and the shared-store revision-protect DELETE trigger behave. A blast
  // radius across unrelated subsystems to fix one counter is the wrong trade.
  //
  // ⚠ THIS IS EXACT FOR EVERY WRITE PATH IN USE, and that is a checked claim,
  // not an assumption: the audit tables are written ONLY through
  // `createSQLiteCollection`, whose single insert is `INSERT OR REPLACE`
  // (`sqlite-collection.ts`). A conflict strategy that SKIPS the insert
  // (`INSERT OR IGNORE`) would fire this trigger and then not insert, leaving
  // `-OLD` behind — so that strategy must not appear on these tables, and a
  // ratchet pins it.
  for (const table of ['audit_entries', 'audit_activities']) {
    db.exec(`
      DROP TRIGGER IF EXISTS ${table}_usage_ins;
      CREATE TRIGGER ${table}_usage_ins
      BEFORE INSERT ON ${table} BEGIN
        UPDATE audit_usage
           SET bytes = bytes + length(NEW.data)
             - COALESCE(
                 (SELECT length(data) FROM ${table} WHERE key = NEW.key), 0)
         WHERE surface = '${AUDIT_USAGE_SURFACE}';
      END;
      CREATE TRIGGER IF NOT EXISTS ${table}_usage_del
      AFTER DELETE ON ${table} BEGIN
        UPDATE audit_usage SET bytes = bytes - length(OLD.data)
         WHERE surface = '${AUDIT_USAGE_SURFACE}';
      END;
      CREATE TRIGGER IF NOT EXISTS ${table}_usage_upd
      AFTER UPDATE ON ${table} BEGIN
        UPDATE audit_usage
           SET bytes = bytes + length(NEW.data) - length(OLD.data)
         WHERE surface = '${AUDIT_USAGE_SURFACE}';
      END;
    `);
  }
};

/** The O(1) read that replaces the hourly full scan.
 *
 *  ⚠ Falls back to the authoritative sum when the counter row is missing, so a
 *  database that somehow reaches this before the migration still gets a CORRECT
 *  answer rather than a zero. A zero here would read as "well under quota" and
 *  silently disable the size-prune pass — the failure mode that must not be
 *  reachable by accident. */
export const readAuditUsageBytes = (db: Database.Database): number => {
  // ⚠ The TABLE may be absent too, not just the row — a database that has not
  // run the migration, or an ephemeral server with no audit log at all. Both
  // fall through to the authoritative sum, which itself returns 0 for missing
  // audit tables. Nothing here throws, and nothing here invents a 0 for a
  // populated log.
  if (!tableExists(db, 'audit_usage')) return recomputeAuditUsageBytes(db);
  const row = db
    .prepare(`SELECT bytes FROM audit_usage WHERE surface = ?`)
    .get(AUDIT_USAGE_SURFACE) as { bytes: number } | undefined;
  return row?.bytes ?? recomputeAuditUsageBytes(db);
};
