/** Phase B: json_extract indexes for the audit-retention pruner.
 *
 *  The audit log is stored via `createSQLiteCollection` as opaque JSON.
 *  The Phase B retention pruner (audit-retention.ts, Commit 7) selects
 *  rows by `started_at` / `timestamp` age AND excludes reserve-class
 *  rows; without these indexes those predicates require a full-table
 *  scan + JSON parse per row, which becomes the dominant cost on large
 *  logs.
 *
 *  All indexes are idempotent (`IF NOT EXISTS`) — safe to call on every
 *  boot. No data migration needed: rows written before Phase B have
 *  `reserve` absent, which the pruner treats as non-reserve. */

import type Database from 'better-sqlite3';

export const ensureAuditIndexes = (db: Database.Database): void => {
  db.exec(`
    CREATE INDEX IF NOT EXISTS audit_entries_reserve_idx
      ON audit_entries (json_extract(data, '$.reserve'));
    CREATE INDEX IF NOT EXISTS audit_entries_started_at_idx
      ON audit_entries (json_extract(data, '$.started_at'));
    CREATE INDEX IF NOT EXISTS audit_activities_reserve_idx
      ON audit_activities (json_extract(data, '$.reserve'));
    CREATE INDEX IF NOT EXISTS audit_activities_timestamp_idx
      ON audit_activities (json_extract(data, '$.timestamp'));
  `);
};
