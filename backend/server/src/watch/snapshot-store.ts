/** Poll-manager / G6 — persisted watch state + record snapshots.
 *
 *  Two SQLite tables in the server's main database:
 *
 *  - `watch_state` — one row per watch key the manager has ever
 *    considered: the user pause toggle, poll bookkeeping
 *    (last_poll_at / last_status / last_error), the baseline flag
 *    (D-124 baseline suppression — the FIRST poll persists a snapshot
 *    WITHOUT firing; set once, survives restart so a restart never
 *    re-fires the world), and the consecutive-failure counter for the
 *    error-cap auto-disable.
 *
 *  - `watch_snapshots` — the per-key canonical-record snapshot the
 *    poll diffs against: `(watch_key, record_id) → (record_hash,
 *    record_json)`. The hash answers "any change?" in one comparison;
 *    the stored projection supplies `prev` for `updated` / `deleted`
 *    payloads. Persisted (design § 3 pin: survive restart).
 *
 *  Snapshot lifecycle: a paused / deferred key KEEPS its snapshot, so
 *  resuming diffs against pre-pause state (changes made while paused
 *  fire as `updated` on the first resumed poll — the user un-pausing
 *  asked to catch up, not to re-baseline). `prune` drops state +
 *  snapshot only for keys with no demand at all (last subscriber
 *  gone), which also forgets a stale pause toggle — a re-demanded key
 *  starts fresh-enabled. */

import type Database from 'better-sqlite3';
import { CONNECTION_API_POLL_SOURCE_ID } from '@recued/contracts';

const STATE_TABLE = 'watch_state';
const SNAPSHOT_TABLE = 'watch_snapshots';

export interface WatchStateRow {
  watch_key: string;
  /** Which registered poll source owns this key (WatchSource model).
   *  Persisted so `listEntries` attributes rows without consulting the
   *  in-memory demand index. */
  source_id: string;
  connection_name: string;
  vendor: string;
  entity: string;
  enabled: boolean;
  baselined: boolean;
  last_poll_at: number | null;
  last_status: 'ok' | 'error' | null;
  last_error: string | null;
  consecutive_failures: number;
  updated_at: number;
}

/** One snapshot record to upsert on `commitSnapshot`. `record` is the
 *  canonical projection (serialized verbatim); `record_hash` is the
 *  caller-computed stable hash over it. */
export interface WatchSnapshotEntry {
  record_id: string;
  record_hash: string;
  record: Record<string, unknown>;
}

export interface WatchSnapshotValue {
  hash: string;
  record: Record<string, unknown>;
}

export interface WatchStore {
  /** Fetch one state row. */
  getState(watch_key: string): WatchStateRow | null;
  /** Insert-if-absent. Existing rows are returned untouched (the user
   *  toggle + poll bookkeeping survive recomputes) — except
   *  `source_id`, which refreshes in place when it differs (a key
   *  re-claimed by a different poll source keeps its toggle + baseline
   *  but re-attributes). */
  ensureState(input: {
    watch_key: string;
    source_id: string;
    connection_name: string;
    vendor: string;
    entity: string;
    now: number;
  }): WatchStateRow;
  /** Flip the user toggle. Enabling also clears the failure counter +
   *  last_error (re-arming an error-capped watch is the same gesture
   *  as un-pausing). Returns null for an unknown key. */
  setEnabled(watch_key: string, enabled: boolean, now: number): WatchStateRow | null;
  /** Record a successful poll: status ok, error cleared, failures
   *  reset; `baselined` latches true once set. */
  recordPollSuccess(watch_key: string, input: { at: number; baselined: boolean }): void;
  /** Record a failed poll. Returns the new consecutive-failure count. */
  recordPollError(watch_key: string, input: { at: number; error: string }): number;
  /** Error-cap auto-disable — flips `enabled` off WITHOUT clearing the
   *  failure counter / last_error (the UI shows why it tripped). */
  disable(watch_key: string, now: number): void;
  listStates(): WatchStateRow[];
  /** Load the full snapshot for one key. Empty map = never baselined
   *  (or pruned). */
  loadSnapshot(watch_key: string): Map<string, WatchSnapshotValue>;
  /** Apply one poll's snapshot delta in a single transaction. */
  commitSnapshot(
    watch_key: string,
    delta: { upserts: ReadonlyArray<WatchSnapshotEntry>; deletes: ReadonlyArray<string> },
  ): void;
  snapshotCount(watch_key: string): number;
  /** Drop state + snapshot for every key NOT in `keep` — the
   *  recompute's orphan sweep (no demand left). */
  prune(keep: ReadonlySet<string>): void;
}

interface StateRow {
  watch_key: string;
  source_id: string;
  connection_name: string;
  vendor: string;
  entity: string;
  enabled: number;
  baselined: number;
  last_poll_at: number | null;
  last_status: string | null;
  last_error: string | null;
  consecutive_failures: number;
  updated_at: number;
}

const toStateRow = (row: StateRow): WatchStateRow => ({
  watch_key: row.watch_key,
  source_id: row.source_id,
  connection_name: row.connection_name,
  vendor: row.vendor,
  entity: row.entity,
  enabled: row.enabled === 1,
  baselined: row.baselined === 1,
  last_poll_at: row.last_poll_at,
  last_status: row.last_status === 'ok' || row.last_status === 'error' ? row.last_status : null,
  last_error: row.last_error,
  consecutive_failures: row.consecutive_failures,
  updated_at: row.updated_at,
});

export const createWatchStore = (db: Database.Database): WatchStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
      watch_key            TEXT PRIMARY KEY,
      source_id            TEXT NOT NULL DEFAULT '${CONNECTION_API_POLL_SOURCE_ID}',
      connection_name      TEXT NOT NULL,
      vendor               TEXT NOT NULL,
      entity               TEXT NOT NULL,
      enabled              INTEGER NOT NULL DEFAULT 1,
      baselined            INTEGER NOT NULL DEFAULT 0,
      last_poll_at         INTEGER,
      last_status          TEXT,
      last_error           TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      updated_at           INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (
      watch_key   TEXT NOT NULL,
      record_id   TEXT NOT NULL,
      record_hash TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (watch_key, record_id)
    );
  `);

  // WatchSource generalization — `source_id` on a table that pre-dates
  // it. Pragma-guarded idempotent ALTER (the `ensureBistemporalSchema`
  // idiom); existing rows backfill to the only source that existed.
  const hasSourceId = (
    db.prepare(`PRAGMA table_info(${STATE_TABLE})`).all() as Array<{ name: string }>
  ).some((c) => c.name === 'source_id');
  if (!hasSourceId) {
    db.exec(
      `ALTER TABLE ${STATE_TABLE} ADD COLUMN source_id TEXT NOT NULL DEFAULT '${CONNECTION_API_POLL_SOURCE_ID}'`,
    );
  }

  const selectState = db.prepare(`SELECT * FROM ${STATE_TABLE} WHERE watch_key = ?`);
  const selectAllStates = db.prepare(`SELECT * FROM ${STATE_TABLE} ORDER BY watch_key ASC`);
  const insertState = db.prepare(
    `INSERT OR IGNORE INTO ${STATE_TABLE}
       (watch_key, source_id, connection_name, vendor, entity, enabled, baselined, consecutive_failures, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?)`,
  );
  const updateSourceId = db.prepare(
    `UPDATE ${STATE_TABLE} SET source_id = ?, updated_at = ? WHERE watch_key = ? AND source_id <> ?`,
  );
  const updateEnabled = db.prepare(
    `UPDATE ${STATE_TABLE}
        SET enabled = ?,
            consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE consecutive_failures END,
            last_error = CASE WHEN ? = 1 THEN NULL ELSE last_error END,
            updated_at = ?
      WHERE watch_key = ?`,
  );
  const updatePollSuccess = db.prepare(
    `UPDATE ${STATE_TABLE}
        SET last_poll_at = ?, last_status = 'ok', last_error = NULL,
            consecutive_failures = 0,
            baselined = CASE WHEN ? = 1 THEN 1 ELSE baselined END,
            updated_at = ?
      WHERE watch_key = ?`,
  );
  const updatePollError = db.prepare(
    `UPDATE ${STATE_TABLE}
        SET last_poll_at = ?, last_status = 'error', last_error = ?,
            consecutive_failures = consecutive_failures + 1,
            updated_at = ?
      WHERE watch_key = ?`,
  );
  const updateDisabled = db.prepare(
    `UPDATE ${STATE_TABLE} SET enabled = 0, updated_at = ? WHERE watch_key = ?`,
  );
  const selectSnapshot = db.prepare(
    `SELECT record_id, record_hash, record_json FROM ${SNAPSHOT_TABLE} WHERE watch_key = ?`,
  );
  const upsertSnapshotRow = db.prepare(
    `INSERT INTO ${SNAPSHOT_TABLE} (watch_key, record_id, record_hash, record_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(watch_key, record_id)
     DO UPDATE SET record_hash = excluded.record_hash, record_json = excluded.record_json`,
  );
  const deleteSnapshotRow = db.prepare(
    `DELETE FROM ${SNAPSHOT_TABLE} WHERE watch_key = ? AND record_id = ?`,
  );
  const countSnapshot = db.prepare<[string], { n: number }>(
    `SELECT COUNT(*) AS n FROM ${SNAPSHOT_TABLE} WHERE watch_key = ?`,
  );
  const deleteStateRow = db.prepare(`DELETE FROM ${STATE_TABLE} WHERE watch_key = ?`);
  const deleteSnapshotAll = db.prepare(`DELETE FROM ${SNAPSHOT_TABLE} WHERE watch_key = ?`);

  const commitSnapshotTx = db.transaction(
    (
      watch_key: string,
      upserts: ReadonlyArray<WatchSnapshotEntry>,
      deletes: ReadonlyArray<string>,
    ) => {
      for (const entry of upserts) {
        upsertSnapshotRow.run(watch_key, entry.record_id, entry.record_hash, JSON.stringify(entry.record));
      }
      for (const record_id of deletes) {
        deleteSnapshotRow.run(watch_key, record_id);
      }
    },
  );

  const pruneTx = db.transaction((keys: ReadonlyArray<string>) => {
    for (const key of keys) {
      deleteStateRow.run(key);
      deleteSnapshotAll.run(key);
    }
  });

  return {
    getState(watch_key) {
      const row = selectState.get(watch_key) as StateRow | undefined;
      return row ? toStateRow(row) : null;
    },
    ensureState(input) {
      insertState.run(
        input.watch_key,
        input.source_id,
        input.connection_name,
        input.vendor,
        input.entity,
        input.now,
      );
      updateSourceId.run(input.source_id, input.now, input.watch_key, input.source_id);
      const row = selectState.get(input.watch_key) as StateRow;
      return toStateRow(row);
    },
    setEnabled(watch_key, enabled, now) {
      const flag = enabled ? 1 : 0;
      const result = updateEnabled.run(flag, flag, flag, now, watch_key);
      if (result.changes === 0) return null;
      const row = selectState.get(watch_key) as StateRow;
      return toStateRow(row);
    },
    recordPollSuccess(watch_key, input) {
      updatePollSuccess.run(input.at, input.baselined ? 1 : 0, input.at, watch_key);
    },
    recordPollError(watch_key, input) {
      updatePollError.run(input.at, input.error, input.at, watch_key);
      const row = selectState.get(watch_key) as StateRow | undefined;
      return row?.consecutive_failures ?? 0;
    },
    disable(watch_key, now) {
      updateDisabled.run(now, watch_key);
    },
    listStates() {
      return (selectAllStates.all() as StateRow[]).map(toStateRow);
    },
    loadSnapshot(watch_key) {
      const out = new Map<string, WatchSnapshotValue>();
      for (const row of selectSnapshot.all(watch_key) as Array<{
        record_id: string;
        record_hash: string;
        record_json: string;
      }>) {
        try {
          const record = JSON.parse(row.record_json) as Record<string, unknown>;
          out.set(row.record_id, { hash: row.record_hash, record });
        } catch {
          // A corrupt row is unreadable as `prev` — drop it from the
          // in-memory view; the next commit overwrites it.
        }
      }
      return out;
    },
    commitSnapshot(watch_key, delta) {
      commitSnapshotTx(watch_key, delta.upserts, delta.deletes);
    },
    snapshotCount(watch_key) {
      return (countSnapshot.get(watch_key) as { n: number }).n;
    },
    prune(keep) {
      const all = selectAllStates.all() as StateRow[];
      const drop = all.map((r) => r.watch_key).filter((k) => !keep.has(k));
      if (drop.length > 0) pruneTx(drop);
      // Orphan snapshots whose state row is already gone (shouldn't
      // happen, but a crash between writes could strand them): sweep
      // any snapshot key not in `keep` either.
      const snapKeys = db
        .prepare(`SELECT DISTINCT watch_key AS k FROM ${SNAPSHOT_TABLE}`)
        .all() as Array<{ k: string }>;
      const orphans = snapKeys.map((r) => r.k).filter((k) => !keep.has(k));
      if (orphans.length > 0) pruneTx(orphans);
    },
  };
};
