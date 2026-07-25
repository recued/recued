/** Phase G (D-109) — archive rpc wire types.
 *
 *  Phase F shipped CLI-only archive export/import. Phase G lands the
 *  rpc surface so the paired extension can drive the flow from Options
 *  → Server → Config. Types live here (not in `backend/server/src/
 *  archive/archive-format.ts`) so the extension can type-check imports
 *  without depending on server-only modules.
 *
 *  `ArchiveManifest` mirrors the on-disk manifest inside
 *  `.recued.archive` files; the import rpc returns it so the ext can
 *  show "restoring 1,243 records from 2026-04-12 snapshot" before
 *  committing. */

/** State of an in-process archive export job. Async because a full
 *  export can take tens of seconds against a warm warehouse — the rpc
 *  returns a `job_id` immediately so the ext polls `server.archive.
 *  status` for progress without holding a WS rpc open for the whole
 *  export.
 *
 *  `running` → `done` (path populated) OR `error` (error populated).
 *  Once terminal, the status can be polled for a short grace window
 *  (~10 min) then the server drops the entry from the in-memory map. */
export interface ArchiveJobStatus {
  state: 'running' | 'done' | 'error';
  /** Bytes written to the output file so far. 0 while scanning
   *  records before the first write. */
  bytes_written: number;
  /** `0`–`100`, rounded. Approximate — computed as
   *  `records_done / records_total` when totals are known, or an
   *  interpolated heuristic during the initial scan. */
  progress_pct: number;
  /** Populated iff `state === 'done'`. Absolute path on the server's
   *  filesystem. */
  path?: string;
  /** Populated iff `state === 'done'`. Unix-ms after which the export
   *  archive is garbage-collected off disk (write time + the 7-day
   *  export TTL). A new export evicts the prior one immediately
   *  (single-latest slot); this TTL backstops an export never replaced.
   *  The ext renders "download by <date>" from it. */
  expires_at?: number;
  /** Populated iff `state === 'error'`. Human-readable — not a stable
   *  error code. */
  error?: string;
}

/** Relationship between a restore archive's identity and the CURRENT
 *  server's realm (the Q2 ownership gate):
 *   - `same`  — the archive's recovery key also matches THIS server's realm
 *               (your own backup, or a fresh/unenrolled server). One key
 *               authorizes the restore; zero extra friction.
 *   - `cross` — the archive belongs to a DIFFERENT recovery key than this
 *               server's realm. The destructive swap additionally requires
 *               the CURRENT realm's recovery key (`currentRealmKey`) + the
 *               strong arm-confirm; this is inherently the re-pair case. */
export type ArchiveRealmRelation = 'same' | 'cross';

/** M5 S3.0 — db-schema compatibility verdict returned on a `dry_run` import so
 *  the UI can warn BEFORE the destructive commit. `archive_too_new` ⇒ the
 *  backup was made by a newer Recued than this server; restoring it is refused
 *  (no downgrade path) until the server is upgraded. `ok` ⇒ same-or-older schema,
 *  which migrates forward on the post-restore restart. The archive's own schema
 *  version rides on `ArchiveManifest.schema_version`. */
export interface ArchiveSchemaCompat {
  status: 'ok' | 'archive_too_new';
  /** This server's current db schema version (for an actionable message). */
  server_schema_version: number;
}

/** Archive manifest summary returned by `server.archive.import`. One
 *  subset of the full on-disk manifest — the fields the ext needs to
 *  render a "confirm restore" panel. */
export interface ArchiveManifest {
  /** Archive format version. `1` at time of Phase F. Bumps only when
   *  the on-disk format changes; Phase G's `event_triggers` table
   *  rides on format v1. */
  format_version: number;
  /** M5 S3.0 — the db SCHEMA version the source server ran (the shape of the
   *  warehouse / server_state / vault tables). Restorable iff `<=` the
   *  restoring binary's schema (an older db migrates forward on boot; a NEWER
   *  one needs a server upgrade — see `schema_compat` on the dry-run). */
  schema_version: number;
  /** ISO-8601 timestamp the source archive was written. */
  exported_at: string;
  /** Total record count across every table in the archive. Sum of
   *  per-table counts; useful for the "restoring N records" banner. */
  record_count: number;
  /** Per-table row counts. Keys are SQLite table names as they live in
   *  the archive. Lets the ext highlight "0 rows imported from
   *  schedules" if the source server had no schedules configured. */
  tables: Record<string, number>;
  /** True when the source archive included CAS blobs (the 64 KB+
   *  record bodies spilled to the filesystem). An archive without
   *  blobs restores metadata + inline bodies only; larger bodies are
   *  silently truncated at restore. */
  includes_blobs: boolean;
  /** True when the source archive embedded a signed identity passport
   *  (`passport.json`). The restore preview surfaces it as "identity
   *  passport: included"; M5's cross-machine migration commits provenance
   *  from it. */
  includes_passport: boolean;
}

/** M5 S2 — driving-client re-pair handoff returned by a COMMITTING
 *  `server.archive.import`. A restore swaps the db, wiping the import-driving
 *  client's bearer row (it lived in the now-discarded db) — so the server
 *  mints a FRESH bearer for that same paired instance INTO the restored
 *  (staged) db and returns it here, on the response sent BEFORE the restart
 *  drain. The driving client stashes `<token_id>.<bearer>` (overwriting its
 *  stored bearer) and reconnects seamlessly into the restored realm — no
 *  re-pair. SAFE because the server's identity key is unchanged: this
 *  preserves an already-authenticated session across the swap it authorized,
 *  it never trusts a new identity. Absent when no driving-client identity is
 *  resolvable (e.g. a non-rpc / unverified caller) → the client re-pairs. */
export interface ArchiveImportRebind {
  /** Public `client_tokens.token_id` of the freshly-issued bearer. */
  token_id: string;
  /** Cleartext bearer — the ONLY moment it exists; the server persists only
   *  its Argon2id hash. The client forms `<token_id>.<bearer>` for the WS
   *  Authorization header. */
  bearer: string;
  /** The paired-instance id the new bearer is bound to (carried in the
   *  token's `metadata.instance_id`), == the driving client's instance. */
  instance_id: string;
}
