/** D-118 Phase 2 — `service_instance_state` SQLite table.
 *
 *  Holds the runtime state of every enrolled `data.service.<slug>`
 *  instance — pid, uptime, last crash, consecutive crashes, last
 *  health, cached quota du sample. Lives next to
 *  `collection_instances` (the durable enrollment row) but is
 *  intentionally ephemeral-ish: the table is wiped on server start
 *  and repopulated by the Phase 5 reconcile pass.
 *
 *  Why a separate table rather than columns on `collection_instances`:
 *  service runtime state changes on every health-check tick and
 *  every restart attempt; piggybacking on the durable enrollment
 *  row would force constant rewrites of the heavier
 *  `caps_json`/`config_json` columns. Splitting keeps the durable
 *  row read-cold and the runtime row write-hot.
 *
 *  Spec note on FK: the spec sketches `FOREIGN KEY (slug) REFERENCES
 *  collection_instances(slug) ON DELETE CASCADE`, but
 *  `collection_instances` has a composite PK `(platform, slug)` —
 *  `slug` alone is not unique across platforms. We enforce cascade
 *  semantically at the app layer instead: the service-platform
 *  enroll/delete handlers (Phase 7) call `clear(slug)` on this table
 *  inside the same transaction that drops the `collection_instances`
 *  row. Equivalent guarantee, no SQLite-side UNIQUE-on-slug
 *  required.
 */

import type Database from 'better-sqlite3';

import type {
  ServiceHealthState,
  ServiceState,
} from '@recued/contracts';

const TABLE = 'service_instance_state';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    slug                    TEXT PRIMARY KEY,
    pid                     INTEGER,
    started_at              INTEGER,
    last_crash_at           INTEGER,
    consecutive_crashes     INTEGER NOT NULL DEFAULT 0,
    last_health_at          INTEGER,
    last_health_state       TEXT,
    last_exit_code          INTEGER,
    quota_bytes_cached      INTEGER NOT NULL DEFAULT 0,
    quota_bytes_sampled_at  INTEGER
  );
`;

const HEALTH_STATES: readonly ServiceHealthState[] = [
  'healthy',
  'unhealthy',
  'unknown',
];

const isHealthState = (v: string): v is ServiceHealthState =>
  (HEALTH_STATES as readonly string[]).includes(v);

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** One row of the runtime state table. Distinct from `ServiceStatus`
 *  (the recipe-facing snapshot) — that shape composes this row with
 *  the manifest's `exposes` map at read time. */
export interface ServiceInstanceStateRecord {
  slug: string;
  pid: number | null;
  started_at: number | null;
  last_crash_at: number | null;
  consecutive_crashes: number;
  last_health_at: number | null;
  last_health_state: ServiceHealthState | null;
  last_exit_code: number | null;
  /** Bytes consumed by this instance's cwd as of the last du sample.
   *  Refreshed by the quota-tracker on a configurable interval. */
  quota_bytes_cached: number;
  /** Unix-ms of the last du sample. `null` before the first sample. */
  quota_bytes_sampled_at: number | null;
}

/** Patch shape for `upsert`. Every field is optional — the store
 *  merges the patch onto the existing row, leaving unspecified
 *  columns unchanged. Useful for narrow updates from each
 *  supervisor event (process started → set pid + started_at; health
 *  tick → set last_health_*; quota sample → set quota_*). */
export interface ServiceInstanceStatePatch {
  pid?: number | null;
  started_at?: number | null;
  last_crash_at?: number | null;
  consecutive_crashes?: number;
  last_health_at?: number | null;
  last_health_state?: ServiceHealthState | null;
  last_exit_code?: number | null;
  quota_bytes_cached?: number;
  quota_bytes_sampled_at?: number | null;
}

/** Derive a `ServiceState` value from a state-table row. Pure;
 *  callers thread it into `ServiceStatus` without touching the
 *  manifest. Tools (no `pid` ever expected) sit at `'unknown'`
 *  here — Phase 6 dispatcher chooses display semantics from caps. */
export const deriveServiceState = (
  row: ServiceInstanceStateRecord,
): ServiceState => {
  if (row.pid !== null && row.started_at !== null) return 'running';
  if (row.last_crash_at !== null) {
    // The supervisor flips consecutive_crashes to the ceiling when
    // it engages permanently_crashed; readers infer the state from
    // that count rather than a separate column.
    if (row.consecutive_crashes >= 5) return 'permanently_crashed';
    return 'crashed';
  }
  if (row.started_at === null && row.last_health_at === null) return 'unknown';
  return 'stopped';
};

export interface ServiceInstanceStateStore {
  /** Insert-or-merge the row keyed by `slug`. Unspecified columns
   *  preserve their existing values; defaulted columns
   *  (`consecutive_crashes`, `quota_bytes_cached`) keep their 0
   *  defaults on first insert when omitted. */
  upsert(slug: string, patch: ServiceInstanceStatePatch): ServiceInstanceStateRecord;
  /** Fetch one row by slug, or `null` when no row exists yet (the
   *  reconcile pass is the only writer that creates rows out of
   *  thin air; lookups before reconcile return null). */
  get(slug: string): ServiceInstanceStateRecord | null;
  /** Every row in the table. Used by the heartbeat enricher (Phase
   *  8) to fold runtime state into `CollectionHealth` without
   *  N+1 lookups. */
  list(): ServiceInstanceStateRecord[];
  /** Drop the row for `slug`. Returns `true` when a row was
   *  deleted, `false` when the slug didn't have one. Cascade
   *  trigger: enroll handlers call this before dropping the
   *  `collection_instances` row in the same transaction. */
  clear(slug: string): boolean;
  /** Truncate the table — called once on server start before the
   *  reconcile pass, to guarantee runtime state never survives a
   *  process restart (pids stale, uptime moot). */
  clearAll(): void;
}

export interface CreateServiceStateStoreOptions {
  db: Database.Database;
}

// ────────────────────────────────────────────────────────────────
// Row marshaling
// ────────────────────────────────────────────────────────────────

interface RawRow {
  slug: string;
  pid: number | null;
  started_at: number | null;
  last_crash_at: number | null;
  consecutive_crashes: number;
  last_health_at: number | null;
  last_health_state: string | null;
  last_exit_code: number | null;
  quota_bytes_cached: number;
  quota_bytes_sampled_at: number | null;
}

const parseRow = (row: RawRow): ServiceInstanceStateRecord => ({
  slug: row.slug,
  pid: row.pid,
  started_at: row.started_at,
  last_crash_at: row.last_crash_at,
  consecutive_crashes: row.consecutive_crashes,
  last_health_at: row.last_health_at,
  last_health_state:
    row.last_health_state !== null && isHealthState(row.last_health_state)
      ? row.last_health_state
      : null,
  last_exit_code: row.last_exit_code,
  quota_bytes_cached: row.quota_bytes_cached,
  quota_bytes_sampled_at: row.quota_bytes_sampled_at,
});

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

export const createServiceStateStore = (
  opts: CreateServiceStateStoreOptions,
): ServiceInstanceStateStore => {
  const { db } = opts;
  db.exec(SCHEMA);

  const insertStmt = db.prepare(`
    INSERT INTO ${TABLE} (
      slug, pid, started_at, last_crash_at, consecutive_crashes,
      last_health_at, last_health_state, last_exit_code,
      quota_bytes_cached, quota_bytes_sampled_at
    ) VALUES (
      @slug, @pid, @started_at, @last_crash_at, @consecutive_crashes,
      @last_health_at, @last_health_state, @last_exit_code,
      @quota_bytes_cached, @quota_bytes_sampled_at
    )
  `);

  const getStmt = db.prepare(`SELECT * FROM ${TABLE} WHERE slug = ?`);
  const listStmt = db.prepare(`SELECT * FROM ${TABLE} ORDER BY slug ASC`);
  const deleteStmt = db.prepare(`DELETE FROM ${TABLE} WHERE slug = ?`);
  const truncateStmt = db.prepare(`DELETE FROM ${TABLE}`);

  return {
    upsert(slug, patch) {
      const existing = getStmt.get(slug) as RawRow | undefined;
      // Merge: patch values win when present, prior row wins when
      // patch omits the column, table defaults (0 for crashes/quota,
      // null for everything else) win on first insert.
      const merged: ServiceInstanceStateRecord = {
        slug,
        pid: patch.pid !== undefined ? patch.pid : existing?.pid ?? null,
        started_at:
          patch.started_at !== undefined
            ? patch.started_at
            : existing?.started_at ?? null,
        last_crash_at:
          patch.last_crash_at !== undefined
            ? patch.last_crash_at
            : existing?.last_crash_at ?? null,
        consecutive_crashes:
          patch.consecutive_crashes !== undefined
            ? patch.consecutive_crashes
            : existing?.consecutive_crashes ?? 0,
        last_health_at:
          patch.last_health_at !== undefined
            ? patch.last_health_at
            : existing?.last_health_at ?? null,
        last_health_state:
          patch.last_health_state !== undefined
            ? patch.last_health_state
            : existing?.last_health_state !== undefined
            ? existing.last_health_state !== null && isHealthState(existing.last_health_state)
              ? (existing.last_health_state as ServiceHealthState)
              : null
            : null,
        last_exit_code:
          patch.last_exit_code !== undefined
            ? patch.last_exit_code
            : existing?.last_exit_code ?? null,
        quota_bytes_cached:
          patch.quota_bytes_cached !== undefined
            ? patch.quota_bytes_cached
            : existing?.quota_bytes_cached ?? 0,
        quota_bytes_sampled_at:
          patch.quota_bytes_sampled_at !== undefined
            ? patch.quota_bytes_sampled_at
            : existing?.quota_bytes_sampled_at ?? null,
      };
      // Idempotent insert-or-replace via DELETE + INSERT inside a
      // transaction. Cleaner than crafting an UPSERT against ten
      // optional columns and matches the merge semantics above.
      const tx = db.transaction((row: ServiceInstanceStateRecord) => {
        deleteStmt.run(row.slug);
        insertStmt.run({
          slug: row.slug,
          pid: row.pid,
          started_at: row.started_at,
          last_crash_at: row.last_crash_at,
          consecutive_crashes: row.consecutive_crashes,
          last_health_at: row.last_health_at,
          last_health_state: row.last_health_state,
          last_exit_code: row.last_exit_code,
          quota_bytes_cached: row.quota_bytes_cached,
          quota_bytes_sampled_at: row.quota_bytes_sampled_at,
        });
      });
      tx(merged);
      return merged;
    },
    get(slug) {
      const row = getStmt.get(slug) as RawRow | undefined;
      return row ? parseRow(row) : null;
    },
    list() {
      const rows = listStmt.all() as RawRow[];
      return rows.map(parseRow);
    },
    clear(slug) {
      const res = deleteStmt.run(slug);
      return res.changes > 0;
    },
    clearAll() {
      truncateStmt.run();
    },
  };
};
