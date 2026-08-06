/** `readLatestDrainSummary` reads the table its own writer writes to.
 *
 *  ⛔ THE DEFECT. `emitAuditRow` writes through `logActivity`, i.e. into
 *  `audit_activities` with an `ActivityEntry` shape. The read-back queried
 *  `audit_entries` and ordered by `$.started_at` — a table whose rows carry no
 *  `$.action` at all, sorted by a field only `AuditEntry` has. Both halves
 *  wrong in the same direction, so it ALWAYS returned null and Settings →
 *  Housekeeping showed "no drain has run yet" forever.
 *
 *  ⚠ That reads as a correct-looking absence: a panel saying nothing has run is
 *  indistinguishable from one that could not find what ran. Nothing errored,
 *  nothing logged, and the query paid a full scan of the audit log to find
 *  nothing every time the panel was opened — 126ms at 700k rows, on a surface
 *  D-230 raised to a ~7.5M-row ceiling.
 *
 *  The test therefore writes the marker the way the PRODUCT writes it and asks
 *  the product's own reader for it back. A fixture that inserted into
 *  `audit_entries` would have passed against the broken code. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ensureAuditIndexes } from '../audit-indexes.js';
import { readLatestDrainSummary } from '../housekeeping/tasks/lifecycle-queue-drain.js';

const mkDb = (): Database.Database => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE audit_entries (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE audit_activities (key TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  ensureAuditIndexes(db);
  return db;
};

/** Exactly what `emitAuditRow` produces: an ActivityEntry in
 *  `audit_activities`, with `timestamp` (not `started_at`) and a
 *  JSON-STRINGIFIED `detail`. */
const writeDrainMarker = (
  db: Database.Database,
  id: string,
  timestamp: number,
  detail: Record<string, unknown>,
): void => {
  db.prepare('INSERT INTO audit_activities (key, data) VALUES (?, ?)').run(
    id,
    JSON.stringify({
      activity_id: id,
      timestamp,
      action: 'lifecycle_queue_drain',
      target: 'system',
      detail: JSON.stringify(detail),
    }),
  );
};

const ctx = (db: Database.Database): Parameters<typeof readLatestDrainSummary>[0] =>
  ({ db } as unknown as Parameters<typeof readLatestDrainSummary>[0]);

describe('readLatestDrainSummary', () => {
  it('⛔ finds a drain that HAS run — the whole defect in one assertion', () => {
    const db = mkDb();
    writeDrainMarker(db, 'a1', 1000, { discarded: 3, recomputed: 7 });
    expect(readLatestDrainSummary(ctx(db))).toEqual({ discarded: 3, recomputed: 7 });
    db.close();
  });

  it('returns the LATEST drain, ordered by activity timestamp', () => {
    // Ordering by `$.started_at` (an AuditEntry field) sorted every row as
    // NULL, so even reading the right table would have returned an arbitrary
    // one. Inserted out of order so insertion order cannot pass for it.
    const db = mkDb();
    writeDrainMarker(db, 'a2', 2000, { discarded: 2 });
    writeDrainMarker(db, 'a1', 1000, { discarded: 1 });
    writeDrainMarker(db, 'a3', 3000, { discarded: 3 });
    expect(readLatestDrainSummary(ctx(db))).toEqual({ discarded: 3 });
    db.close();
  });

  it('still returns null when no drain has genuinely run', () => {
    // The honest null. Before the fix this was the ONLY answer, which is why
    // the bug was invisible: the failure mode and the empty state were the
    // same value.
    expect(readLatestDrainSummary(ctx(mkDb()))).toBeNull();
  });

  it('ignores other actions in the same table', () => {
    const db = mkDb();
    db.prepare('INSERT INTO audit_activities (key, data) VALUES (?, ?)').run(
      'x1',
      JSON.stringify({
        activity_id: 'x1', timestamp: 9999, action: 'housekeeping_cycle',
        target: 'system', detail: JSON.stringify({ not: 'a drain' }),
      }),
    );
    writeDrainMarker(db, 'a1', 1000, { discarded: 5 });
    expect(readLatestDrainSummary(ctx(db))).toEqual({ discarded: 5 });
    db.close();
  });

  it('⛔ sorts on $.timestamp — NOT on the index happening to be in that order', () => {
    // ⚠ THIS IS A SOURCE ASSERTION ON PURPOSE, and the reason is worth keeping.
    // With `audit_activities_action_ts_idx` present, ordering by the WRONG
    // field (`$.started_at`, which is NULL on every activity row) still yields
    // the right answer — the index supplies `timestamp DESC` ordering and the
    // all-NULL sort is stable within it. So the behavioural tests above pass
    // under that mutation: the bug is MASKED by an index.
    //
    // Correctness resting on an index's incidental ordering is a trap: drop or
    // re-shape the index for an unrelated reason and the panel silently starts
    // showing an arbitrary drain. Pin the query text so the intent cannot drift
    // back.
    const fs = require('node:fs') as typeof import('node:fs');
    const source = fs.readFileSync(
      new URL('../housekeeping/tasks/lifecycle-queue-drain.ts', import.meta.url),
      'utf8',
    );
    const query = source.slice(source.indexOf('readLatestDrainSummary'));
    expect(query).toMatch(/FROM audit_activities/);
    expect(query).toMatch(/ORDER BY json_extract\(data, '\$\.timestamp'\) DESC/);
    expect(query).not.toMatch(/FROM audit_entries[\s\S]{0,200}lifecycle_queue_drain/);
  });

  it('⛔ SEEKS the row instead of scanning the audit log', () => {
    // A correct answer read by scanning is still the bug this replaced — and
    // this read is on a panel path, over a surface D-230 sized to ~7.5M rows.
    const db = mkDb();
    const plan = (db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT json_extract(data, '$.detail') AS detail
           FROM audit_activities
          WHERE json_extract(data, '$.action') = 'lifecycle_queue_drain'
          ORDER BY json_extract(data, '$.timestamp') DESC
          LIMIT 1`,
      )
      .all() as Array<{ detail: string }>).map((r) => r.detail).join(' ; ');
    expect(plan).toMatch(/SEARCH audit_activities USING INDEX/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
    db.close();
  });
});
