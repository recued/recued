/** D-250 § D8.1 slice 1 — the two metric stores.
 *
 *  ⛔⛔ TWO TABLES, NOT ONE, AND THE SPLIT IS A SEMANTIC ONE (amendment 17). They differ
 *  in HOW A VALUE IS PRODUCED, which is why one table with a "kind" column would be the
 *  wrong shape:
 *
 *  - `metric_snapshot` is RECOMPUTED from the audit window and REPLACED WHOLE. It keeps
 *    no memory, holds no per-day series, and supports no read-back — amendment 16:
 *    "always the most recent snapshot". Nothing in it survives audit eviction, and that
 *    is deliberate: it is what GUARANTEES Recued's own metrics are never
 *    contribution-shaped, since a cumulative total needs durable history by
 *    construction.
 *  - `metric_artifact` ADVANCES from its own previous value plus today. It never scans
 *    the past, so it needs one prior key rather than a history — and the earned facts
 *    therefore outlive the raw rows they came from.
 *
 *  ⚠ NOT REGENERABLE, AND THE SURFACE MUST SAY SO. Lose `metric_artifact` after the
 *  audit rows evict and "first pack published" cannot be recomputed from anything.
 *  That is amendment 14's regenerable-or-not disclosure pointing at our own store.
 *  Do not build recovery for a local-only badge; disclose it.
 *
 *  Server-internal, outside any namespace, never synced (D-097 / D-168).
 */

import type Database from 'better-sqlite3';

/** The snapshot is a SINGLETON, and the CHECK makes that structural rather than
 *  documented. Amendment 16 ruled out a per-day series; a table that merely happened to
 *  hold one row would grow one the first time someone wrote with a different key. */
export const METRIC_SNAPSHOT_PRIMARY_KEY = 'singleton';

export const ensureMetricSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metric_snapshot (
      id TEXT PRIMARY KEY CHECK (id = '${METRIC_SNAPSHOT_PRIMARY_KEY}'),
      data TEXT NOT NULL,
      computed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS metric_artifact (
      key TEXT PRIMARY KEY,
      -- ⛔ THE KIND IS PINNED ON FIRST WRITE AND CHECKED ON EVERY LATER ONE. It is what
      -- makes "a record only ever advances" an enforced property instead of a comment:
      -- writing a record key through the counter path is rejected, so a quiet week
      -- cannot lower a standing best.
      kind TEXT NOT NULL CHECK (kind IN ('record', 'once', 'counter')),
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
};
