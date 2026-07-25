/** D-172 resumable uploads — SHARED `upload_session` store.
 *
 *  Transport-only state for an in-flight chunked upload (flaky/mobile large
 *  files). Generalized out of P1a's reception-only store so BOTH consumers —
 *  the open reception drop page and the authenticated webclient Data→File view
 *  — share one substrate (the rev-3 reframe: the resumable uploader is a
 *  general file-ingest capability, not reception-only). The CONSUMER is named
 *  by `(scope_kind, scope_key)`:
 *    - reception → `scope_key` = the drop-link `endpoint_id`.
 *    - webclient → `scope_key` = the owner / instance id.
 *
 *  A session binds the FILE IDENTITY (`filename` + `declared_size` + optional
 *  head/tail `fingerprint`) so a file-switch or stale resume can never append
 *  into the wrong scratch, and holds `offset_bytes` as the PERSISTED SOURCE OF
 *  TRUTH (acked bytes) + the scratch path. Visitor / owner PII is NOT stored
 *  here — reception seals it at FINALIZE into `reception_drop_blob_metadata`
 *  (exactly as the single-POST path does); webclient finalize ingests into
 *  `data.file`. Either way the session row is pure transport.
 *
 *  Lifecycle: `expires_at` is bumped to `now + TTL` on every chunk/probe; the
 *  housekeeping sweeper reaps rows with `expires_at <= now` (the universal
 *  catch-all for idle / abandoned / premature-quit, which are indistinguishable
 *  from idle server-side) and unlinks their scratch. Crash-correctness (the
 *  truncate-the-scratch-to-`offset_bytes`-on-resume rule) lives in the chunk
 *  HANDLER (later slice) — this store keeps `offset_bytes` as the only authority.
 *
 *  Pure SQLite + logic (no crypto, no fs); self-owns its schema via
 *  `ensureUploadSessionSchema` (mirrors `ensureContactSchema`). Server-internal,
 *  per-pair — no cross-cloud sync (D-097 / D-168).
 *
 *  Spec: `recued-project/handovers/handover_drop_resumable_upload_design.md`. */

import type Database from 'better-sqlite3';

// ────────────────────────────────────────────────────────────────
// Constants (code constants, not user-tunable settings — there is no
// Settings home for per-link knobs; mirrors the messenger idle-timeout call).
// The abuse caps are SHARED DEFAULTS the chunk-core's per-consumer policy
// (later slice) applies — reception enforces the concurrent + pending-bytes
// caps; the authenticated webclient runs a lighter gate (one trusted tenant,
// the disk bound still applies).
// ────────────────────────────────────────────────────────────────

/** Resume window — a session with no chunk/probe activity for this long is
 *  reaped (scratch + row). Generous so a visitor can pause + resume later. */
export const UPLOAD_SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/** Max bytes accepted in a SINGLE chunk PATCH — bounds per-request work +
 *  keeps progress granular. The client picks its chunk size ≤ this. */
export const UPLOAD_CHUNK_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB

/** Per-scope concurrent open-session cap — the first half of the
 *  scratch-disk-DoS bound (refuse Create past it). For reception a scope is one
 *  drop-link endpoint; for webclient one owner. */
export const UPLOAD_MAX_CONCURRENT_SESSIONS_PER_SCOPE = 5;

/** Global pending-bytes cap (sum of `declared_size` over live sessions) — the
 *  second half of the disk bound. Recomputed from live rows, never a drifting
 *  counter, so a crashed decrement can't strand the budget. */
export const UPLOAD_MAX_PENDING_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB

/** Which consumer owns a session. Drives finalize routing + the abuse policy
 *  the chunk-core applies; never crosses the cloud (server-internal).
 *    - reception → `scope_key` = the drop-link `endpoint_id`.
 *    - webclient → `scope_key` = the owner / instance id (Data → File ingest).
 *    - archive   → `scope_key` = the owner / instance id (M4b.1 no-SSH migrate;
 *                  finalize STAGES to `exports/` instead of ingesting a row). */
export type UploadScopeKind = 'reception' | 'webclient' | 'archive';

interface UploadSessionRow {
  upload_id: string;
  scope_kind: UploadScopeKind;
  scope_key: string;
  filename: string;
  declared_size: number;
  fingerprint: string | null;
  mime_reported: string;
  offset_bytes: number;
  scratch_path: string;
  source_ip_hash: string | null;
  created_at: number;
  expires_at: number;
}

export interface UploadSession {
  readonly upload_id: string;
  readonly scope_kind: UploadScopeKind;
  readonly scope_key: string;
  readonly filename: string;
  readonly declared_size: number;
  readonly fingerprint: string | null;
  readonly mime_reported: string;
  readonly offset_bytes: number;
  readonly scratch_path: string;
  readonly source_ip_hash: string | null;
  readonly created_at: number;
  readonly expires_at: number;
}

export interface UploadSessionCreateInput {
  readonly upload_id: string;
  readonly scope_kind: UploadScopeKind;
  readonly scope_key: string;
  readonly filename: string;
  readonly declared_size: number;
  readonly fingerprint?: string | null;
  readonly mime_reported: string;
  readonly scratch_path: string;
  readonly source_ip_hash?: string | null;
  readonly now: number;
  readonly ttl_ms?: number;
}

/** Result of an offset advance — `conflict` means the caller's
 *  `expected_offset` did not match the persisted offset (a gap / rewrite / a
 *  re-sent already-acked chunk on a stale client), which the handler maps to a
 *  409 carrying the real offset so the client re-syncs. */
export type AdvanceOffsetResult = 'ok' | 'conflict' | 'not_found';

export interface UploadSessionStore {
  create(input: UploadSessionCreateInput): UploadSession;
  get(upload_id: string): UploadSession | null;
  /** Contiguous, atomic offset advance: persist `new_offset` + bump expiry IFF
   *  the stored offset still equals `expected_offset` (rejects gaps/rewrites). */
  advanceOffset(input: {
    upload_id: string;
    expected_offset: number;
    new_offset: number;
    now: number;
    ttl_ms?: number;
  }): AdvanceOffsetResult;
  /** Bump expiry on a resume probe (keeps an active session alive). */
  touch(input: { upload_id: string; now: number; ttl_ms?: number }): 'ok' | 'not_found';
  delete(upload_id: string): 'deleted' | 'not_found';
  /** Live (non-expired) session count for a scope — concurrent-session cap. */
  countActiveForScope(input: {
    scope_kind: UploadScopeKind;
    scope_key: string;
    now: number;
  }): number;
  /** Sum of `declared_size` over live (non-expired) sessions — pending-bytes cap.
   *  Recomputed from rows (no drifting counter). */
  sumActivePendingBytes(input: { now: number }): number;
  /** Sessions whose `expires_at <= now` — the sweeper reaps these. */
  listExpired(input: { now: number; limit?: number }): ReadonlyArray<UploadSession>;
}

/** Idempotent schema install — safe to call on every boot. Mirrors the
 *  per-store pattern (`ensureContactSchema` / `ensureCorrectionEventsSchema`).
 *  `offset` is a SQL keyword → `offset_bytes`. */
export const ensureUploadSessionSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS upload_session (
      upload_id        TEXT PRIMARY KEY,
      scope_kind       TEXT NOT NULL,
      scope_key        TEXT NOT NULL,
      filename         TEXT NOT NULL,
      declared_size    INTEGER NOT NULL,
      fingerprint      TEXT,
      mime_reported    TEXT NOT NULL,
      offset_bytes     INTEGER NOT NULL,
      scratch_path     TEXT NOT NULL,
      source_ip_hash   TEXT,
      created_at       INTEGER NOT NULL,
      expires_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_upload_session_scope
      ON upload_session (scope_kind, scope_key);
    CREATE INDEX IF NOT EXISTS idx_upload_session_expiry
      ON upload_session (expires_at);
  `);
};

const rowToSession = (row: UploadSessionRow): UploadSession => ({
  upload_id: row.upload_id,
  scope_kind: row.scope_kind,
  scope_key: row.scope_key,
  filename: row.filename,
  declared_size: row.declared_size,
  fingerprint: row.fingerprint,
  mime_reported: row.mime_reported,
  offset_bytes: row.offset_bytes,
  scratch_path: row.scratch_path,
  source_ip_hash: row.source_ip_hash,
  created_at: row.created_at,
  expires_at: row.expires_at,
});

export const createUploadSessionStore = (
  db: Database.Database,
): UploadSessionStore => {
  ensureUploadSessionSchema(db);

  const insertStmt = db.prepare(`
    INSERT INTO upload_session (
      upload_id, scope_kind, scope_key, filename, declared_size, fingerprint,
      mime_reported, offset_bytes, scratch_path, source_ip_hash,
      created_at, expires_at
    ) VALUES (
      @upload_id, @scope_kind, @scope_key, @filename, @declared_size, @fingerprint,
      @mime_reported, 0, @scratch_path, @source_ip_hash,
      @created_at, @expires_at
    )
  `);
  const getStmt = db.prepare(
    `SELECT * FROM upload_session WHERE upload_id = @upload_id`,
  );
  const advanceStmt = db.prepare(`
    UPDATE upload_session
       SET offset_bytes = @new_offset, expires_at = @expires_at
     WHERE upload_id = @upload_id AND offset_bytes = @expected_offset
  `);
  const touchStmt = db.prepare(`
    UPDATE upload_session
       SET expires_at = @expires_at
     WHERE upload_id = @upload_id
  `);
  const deleteStmt = db.prepare(
    `DELETE FROM upload_session WHERE upload_id = @upload_id`,
  );
  const countActiveStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM upload_session
     WHERE scope_kind = @scope_kind AND scope_key = @scope_key AND expires_at > @now
  `);
  const sumPendingStmt = db.prepare(`
    SELECT COALESCE(SUM(declared_size), 0) AS total FROM upload_session
     WHERE expires_at > @now
  `);
  const listExpiredStmt = db.prepare(`
    SELECT * FROM upload_session
     WHERE expires_at <= @now
     ORDER BY expires_at ASC
     LIMIT @limit
  `);

  return {
    create(input) {
      const ttl = input.ttl_ms ?? UPLOAD_SESSION_TTL_MS;
      insertStmt.run({
        upload_id: input.upload_id,
        scope_kind: input.scope_kind,
        scope_key: input.scope_key,
        filename: input.filename,
        declared_size: input.declared_size,
        fingerprint: input.fingerprint ?? null,
        mime_reported: input.mime_reported,
        scratch_path: input.scratch_path,
        source_ip_hash: input.source_ip_hash ?? null,
        created_at: input.now,
        expires_at: input.now + ttl,
      });
      const row = getStmt.get({ upload_id: input.upload_id }) as
        | UploadSessionRow
        | undefined;
      if (!row) throw new Error('UploadSessionStore.create: row missing after insert');
      return rowToSession(row);
    },

    get(upload_id) {
      const row = getStmt.get({ upload_id }) as UploadSessionRow | undefined;
      return row ? rowToSession(row) : null;
    },

    advanceOffset(input) {
      const ttl = input.ttl_ms ?? UPLOAD_SESSION_TTL_MS;
      const res = advanceStmt.run({
        upload_id: input.upload_id,
        new_offset: input.new_offset,
        expected_offset: input.expected_offset,
        expires_at: input.now + ttl,
      });
      if (res.changes > 0) return 'ok';
      // 0 rows changed — distinguish a missing session from an offset conflict.
      const row = getStmt.get({ upload_id: input.upload_id }) as
        | UploadSessionRow
        | undefined;
      return row ? 'conflict' : 'not_found';
    },

    touch(input) {
      const ttl = input.ttl_ms ?? UPLOAD_SESSION_TTL_MS;
      const res = touchStmt.run({
        upload_id: input.upload_id,
        expires_at: input.now + ttl,
      });
      return res.changes > 0 ? 'ok' : 'not_found';
    },

    delete(upload_id) {
      const res = deleteStmt.run({ upload_id });
      return res.changes > 0 ? 'deleted' : 'not_found';
    },

    countActiveForScope(input) {
      const row = countActiveStmt.get({
        scope_kind: input.scope_kind,
        scope_key: input.scope_key,
        now: input.now,
      }) as { n: number };
      return row.n;
    },

    sumActivePendingBytes(input) {
      const row = sumPendingStmt.get({ now: input.now }) as { total: number };
      return row.total;
    },

    listExpired(input) {
      const rows = listExpiredStmt.all({
        now: input.now,
        limit: input.limit ?? 100,
      }) as UploadSessionRow[];
      return rows.map(rowToSession);
    },
  };
};
