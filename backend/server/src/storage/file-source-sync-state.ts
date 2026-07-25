/** D-192 file SOURCE family — the `file_source_sync_state` runtime health row.
 *
 *  The file-family counterpart of `work_entity_source_sync_state`
 *  (`work-entity-source-mirror.ts`): ONE row per file Source recording the last
 *  sync cycle's health + a forward delta-cursor slot. It REPLACES the slice-4
 *  audit-row stopgap (`file_source_sync_{failed,degraded}` emitted from the
 *  housekeeping task) — a failed / degraded cycle is now a queryable state row,
 *  not a scattered audit line, and it is the freshness input the
 *  `source_freshness_degradation` producer reads for a file Source
 *  (`last_success_at` → `last_seen_at`; `degraded` → a coverage reason).
 *
 *  Thinner than the work-entity row: file Source SYNC is always a read-only
 *  metadata mirror, so there is no `sync_mode` / `sync_depth` (both would be
 *  constant) and no declaration-hash column. Explicit reads are a separate,
 *  policy-gated path and do not change sync posture. A
 *  delta-capable vendor (Dropbox `list.mode: 'full_then_delta'`) rides
 *  `cursor_blob` — the opaque watermark the leaf's `next_cursor` advances — and
 *  re-baselines with a full walk whenever `last_full_walk_at` ages past
 *  {@link FILE_SOURCE_FULL_WALK_INTERVAL_MS} (the delete authority; a delta walk
 *  upserts changes but never tombstones). A `full` vendor (S3) leaves
 *  `cursor_blob` null and full-walks every cycle. `stale_after_ms` is a
 *  file-source constant (no per-vendor variance in v1).
 *
 *  Lifecycle mirrors the work-entity store: seeded (`upsert`) at task
 *  registration, `markStarted` / `markCompleted` per cycle, `deleteForSource` on
 *  unregister (runtime state, not preserved history). Design:
 *  D-192. */

import type Database from 'better-sqlite3';

export const FILE_SOURCE_SYNC_STATE_TABLE = 'file_source_sync_state';

/** Staleness threshold for a file meta mirror. Housekeeping-cadence sync + low
 *  churn — matches the work-entity kernel declarations' 6h. A single constant
 *  (no per-vendor variance in v1); a future per-vendor knob would land on the
 *  `FileVendorDeclaration`. */
export const FILE_SOURCE_STALE_AFTER_MS = 21_600_000; // 6h

/** How often a delta-capable Source re-baselines with a FULL walk (the delete
 *  authority — a delta walk upserts changes but never tombstones, so removals
 *  reconcile only on the next full re-list). A `full` vendor (S3) full-walks
 *  every cycle regardless (it never holds a cursor). At 24h against the ~6h idle
 *  staleness, a delete lags at most one day — cheap for a meta-only mirror; a
 *  tighter bound trades API-call volume back. */
export const FILE_SOURCE_FULL_WALK_INTERVAL_MS = 86_400_000; // 24h

export interface FileSourceSyncState {
  source_id: string;
  /** Opaque delta-cursor watermark persisted from the leaf's `next_cursor`.
   *  null = no watermark yet ⇒ the next cycle full-walks from scratch. A
   *  delta-capable vendor (Dropbox `cursor`) advances it each cycle; a `full`
   *  vendor (S3) leaves it null. */
  cursor_blob: string | null;
  last_sync_started_at: number | null;
  last_sync_completed_at: number | null;
  last_success_at: number | null;
  /** When the last CLEAN full walk completed — the delete-authority watermark.
   *  The runner forces a full re-list (delete reconcile) when this is null
   *  (never baselined) or older than {@link FILE_SOURCE_FULL_WALK_INTERVAL_MS},
   *  and rides deltas in between. A degraded cycle never bumps it (no clean
   *  baseline was proven), so a poisoned Source keeps re-attempting the full
   *  walk. */
  last_full_walk_at: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  /** True when the last cycle failed the fetch OR failed / could not key a row
   *  — a degraded Source reads as stale regardless of `last_success_at`. */
  degraded: boolean;
  stale_after_ms: number;
}

export interface FileSourceSyncStateStore {
  get(source_id: string): FileSourceSyncState | null;
  /** Seed / replace a row. The wire seeds-if-absent at task registration, so
   *  health is preserved across boot re-scans; a direct call replaces the row. */
  upsert(state: FileSourceSyncState): void;
  /** Mark a cycle start (started_at now; leaves the rest intact). Row must
   *  exist — the wire seeds it at registration, before any step can run. */
  markStarted(source_id: string, now: number): void;
  /** Record a cycle outcome. A clean cycle bumps `last_success_at` + clears the
   *  error/degraded flags + advances the cursor; a failed OR degraded cycle
   *  records the error and sets `degraded` WITHOUT bumping `last_success_at`
   *  (so the freshness reader treats it as stale). A clean cycle whose walk was
   *  a FULL re-list passes `full_walk: true` to also stamp `last_full_walk_at`
   *  (the delete-authority watermark); a delta cycle omits it. */
  markCompleted(
    source_id: string,
    outcome:
      | { ok: true; cursor_blob?: string | null; full_walk?: boolean; now: number }
      | { ok: false; error_code: string; error_message: string; now: number },
  ): void;
  /** Hard-delete the row (Source unregistered — runtime state, not history). */
  deleteForSource(source_id: string): boolean;
}

/** D-192 file-kind hardening — the freshness verdict for a file Source's mirror,
 *  derived from its sync-state row. This is the shape `DataFileView.freshness`
 *  surfaces (Fork B) so a reader (the mirror-search picker / timeline drill-down
 *  / MCP) knows how CURRENT a remote mirror is. A degraded or never-synced
 *  Source, or one whose last clean cycle is older than `stale_after_ms`, reads
 *  STALE. `state === null` (no Source row — the Source was never registered or
 *  was unregistered) → stale + never-synced. Pure. */
export interface FileSourceFreshness {
  /** The last clean cycle's completion time; null = never synced. */
  last_success_at: number | null;
  /** The last cycle failed / could not key a row (reads stale regardless of time). */
  degraded: boolean;
  /** Degraded, never-synced, or `now - last_success_at > stale_after_ms`. */
  stale: boolean;
}

export const deriveFileSourceFreshness = (
  state: FileSourceSyncState | null,
  now: number,
): FileSourceFreshness => {
  if (state === null) return { last_success_at: null, degraded: false, stale: true };
  const stale =
    state.degraded
    || state.last_success_at === null
    || now - state.last_success_at > state.stale_after_ms;
  return { last_success_at: state.last_success_at, degraded: state.degraded, stale };
};

/** A fresh, never-synced state row for a newly-registered file Source. */
export const initialFileSourceSyncState = (source_id: string): FileSourceSyncState => ({
  source_id,
  cursor_blob: null,
  last_sync_started_at: null,
  last_sync_completed_at: null,
  last_success_at: null,
  last_full_walk_at: null,
  last_error_code: null,
  last_error_message: null,
  degraded: false,
  stale_after_ms: FILE_SOURCE_STALE_AFTER_MS,
});

/** Idempotent (`IF NOT EXISTS`). Pre-launch, a table whose SHAPE is replaced is
 *  wiped, never migrated — but `last_full_walk_at` is an ADDITIVE nullable
 *  column the delta-cursor slice adds to the table the sync-state slice already
 *  shipped, so it is reconciled with the project's PRAGMA-guarded `ADD COLUMN`
 *  idiom (same as `connection-store` / the enrichment store) rather than forcing
 *  a dev-DB wipe — otherwise the store's prepared statements referencing the
 *  column would fail on an existing table. A legacy row reads `last_full_walk_at:
 *  null` → the runner treats it as never-baselined and full-walks (the correct
 *  default). Soft reference to the file Source registry — the sync wire calls
 *  `deleteForSource` on unregister, mirroring an ON DELETE CASCADE intent without
 *  coupling table lifetimes across modules. */
export const ensureFileSourceSyncStateSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${FILE_SOURCE_SYNC_STATE_TABLE} (
      source_id               TEXT PRIMARY KEY,
      cursor_blob             TEXT,
      last_sync_started_at    INTEGER,
      last_sync_completed_at  INTEGER,
      last_success_at         INTEGER,
      last_full_walk_at       INTEGER,
      last_error_code         TEXT,
      last_error_message      TEXT,
      degraded                INTEGER NOT NULL DEFAULT 0,
      stale_after_ms          INTEGER NOT NULL
    );
  `);
  // Additive nullable column for a DB created by the sync-state slice (before
  // delta cursors). `CREATE TABLE IF NOT EXISTS` won't widen an existing table,
  // so guard with PRAGMA table_info (same idiom as `connection-store`).
  const cols = db
    .prepare(`PRAGMA table_info(${FILE_SOURCE_SYNC_STATE_TABLE})`)
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === 'last_full_walk_at')) {
    db.exec(`ALTER TABLE ${FILE_SOURCE_SYNC_STATE_TABLE} ADD COLUMN last_full_walk_at INTEGER`);
  }
};

export const createFileSourceSyncStateStore = (
  db: Database.Database,
): FileSourceSyncStateStore => {
  const getStmt = db.prepare(`SELECT * FROM ${FILE_SOURCE_SYNC_STATE_TABLE} WHERE source_id = ?`);
  const upsertStmt = db.prepare(`
    INSERT INTO ${FILE_SOURCE_SYNC_STATE_TABLE}
      (source_id, cursor_blob, last_sync_started_at, last_sync_completed_at,
       last_success_at, last_full_walk_at, last_error_code, last_error_message,
       degraded, stale_after_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_id) DO UPDATE SET
      cursor_blob = excluded.cursor_blob,
      last_sync_started_at = excluded.last_sync_started_at,
      last_sync_completed_at = excluded.last_sync_completed_at,
      last_success_at = excluded.last_success_at,
      last_full_walk_at = excluded.last_full_walk_at,
      last_error_code = excluded.last_error_code,
      last_error_message = excluded.last_error_message,
      degraded = excluded.degraded,
      stale_after_ms = excluded.stale_after_ms
  `);
  const startStmt = db.prepare(
    `UPDATE ${FILE_SOURCE_SYNC_STATE_TABLE} SET last_sync_started_at = ? WHERE source_id = ?`,
  );
  // A clean cycle clears error/degraded + advances the cursor. Two variants:
  // a FULL re-list also stamps `last_full_walk_at` (the delete-authority
  // watermark); a delta cycle leaves it untouched (no fresh baseline proven).
  const okFullStmt = db.prepare(`
    UPDATE ${FILE_SOURCE_SYNC_STATE_TABLE} SET
      last_sync_completed_at = ?, last_success_at = ?, cursor_blob = ?,
      last_full_walk_at = ?,
      last_error_code = NULL, last_error_message = NULL, degraded = 0
    WHERE source_id = ?
  `);
  const okDeltaStmt = db.prepare(`
    UPDATE ${FILE_SOURCE_SYNC_STATE_TABLE} SET
      last_sync_completed_at = ?, last_success_at = ?, cursor_blob = ?,
      last_error_code = NULL, last_error_message = NULL, degraded = 0
    WHERE source_id = ?
  `);
  const errStmt = db.prepare(`
    UPDATE ${FILE_SOURCE_SYNC_STATE_TABLE} SET
      last_sync_completed_at = ?, last_error_code = ?, last_error_message = ?, degraded = 1
    WHERE source_id = ?
  `);
  const delStmt = db.prepare(`DELETE FROM ${FILE_SOURCE_SYNC_STATE_TABLE} WHERE source_id = ?`);

  const rowToState = (row: Record<string, unknown>): FileSourceSyncState => ({
    source_id: row.source_id as string,
    cursor_blob: (row.cursor_blob as string | null) ?? null,
    last_sync_started_at: (row.last_sync_started_at as number | null) ?? null,
    last_sync_completed_at: (row.last_sync_completed_at as number | null) ?? null,
    last_success_at: (row.last_success_at as number | null) ?? null,
    last_full_walk_at: (row.last_full_walk_at as number | null) ?? null,
    last_error_code: (row.last_error_code as string | null) ?? null,
    last_error_message: (row.last_error_message as string | null) ?? null,
    degraded: row.degraded === 1,
    stale_after_ms: row.stale_after_ms as number,
  });

  return {
    get(source_id) {
      const row = getStmt.get(source_id) as Record<string, unknown> | undefined;
      return row === undefined ? null : rowToState(row);
    },
    upsert(s) {
      upsertStmt.run(
        s.source_id, s.cursor_blob, s.last_sync_started_at, s.last_sync_completed_at,
        s.last_success_at, s.last_full_walk_at, s.last_error_code, s.last_error_message,
        s.degraded ? 1 : 0, s.stale_after_ms,
      );
    },
    markStarted(source_id, now) {
      startStmt.run(now, source_id);
    },
    markCompleted(source_id, outcome) {
      if (outcome.ok) {
        const cursor = outcome.cursor_blob ?? null;
        if (outcome.full_walk === true) {
          okFullStmt.run(outcome.now, outcome.now, cursor, outcome.now, source_id);
        } else {
          okDeltaStmt.run(outcome.now, outcome.now, cursor, source_id);
        }
      } else {
        errStmt.run(outcome.now, outcome.error_code, outcome.error_message, source_id);
      }
    },
    deleteForSource(source_id) {
      return delStmt.run(source_id).changes > 0;
    },
  };
};
