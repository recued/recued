/** D-138 P5 — upstream-merge outbox storage.
 *
 *  One SQLite table backs the outbox state machine. Server-internal —
 *  no cross-cloud sync (D-097 / D-168 — the outbox row is per-server
 *  durable state; cross-device sync would clone the in-flight upstream
 *  merge onto another instance which is exactly what we don't want).
 *
 *  Schema:
 *    upstream_merge_outbox
 *      id                TEXT PRIMARY KEY  (ULID)
 *      approval_id       TEXT NOT NULL
 *      vendor            TEXT NOT NULL  ('hubspot' | 'salesforce')
 *      object_type       TEXT NOT NULL  ('hubspot:contact' | …)
 *      candidate_ids     TEXT NOT NULL  (JSON string array)
 *      survivor_email    TEXT NOT NULL
 *      loser_emails      TEXT NOT NULL  (JSON string array)
 *      vendor_pairs      TEXT NOT NULL  (JSON object array)
 *      idempotency_key   TEXT NOT NULL UNIQUE
 *      state             TEXT NOT NULL
 *      attempts          INTEGER NOT NULL DEFAULT 0
 *      last_attempt_at   INTEGER
 *      pre_merge_snapshot TEXT
 *      last_error        TEXT
 *      created_at        INTEGER NOT NULL
 *      updated_at        INTEGER NOT NULL
 *
 *  Idempotency: `idempotency_key` is UNIQUE — duplicate request rpcs
 *  collapse onto the same row at insert time. Boot recovery picks up
 *  every recoverable row and replays the next state transition.
 *
 *  Spec: `docs/d-138-spec.md` § A.7 + § Phase 5. */

import type Database from 'better-sqlite3';
import {
  isUpstreamMergeRecoverable,
  isUpstreamMergeTerminal,
  nextUpstreamMergeState,
  type UpstreamMergeError,
  type UpstreamMergeEvent,
  type UpstreamMergeObjectType,
  type UpstreamMergeOutboxRow,
  type UpstreamMergeState,
  type UpstreamMergeVendor,
  type UpstreamMergeVendorPair,
} from '@recued/contracts';

const TABLE = 'upstream_merge_outbox';

export const ensureUpstreamMergeOutboxSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id                       TEXT PRIMARY KEY,
      approval_id              TEXT NOT NULL,
      vendor                   TEXT NOT NULL,
      object_type              TEXT NOT NULL,
      candidate_ids            TEXT NOT NULL,
      survivor_email           TEXT NOT NULL,
      loser_emails             TEXT NOT NULL,
      vendor_pairs             TEXT NOT NULL,
      idempotency_key          TEXT NOT NULL UNIQUE,
      state                    TEXT NOT NULL,
      attempts                 INTEGER NOT NULL DEFAULT 0,
      last_attempt_at          INTEGER,
      pre_merge_snapshot       TEXT,
      last_error               TEXT,
      connection_name          TEXT,
      same_user_auto_approve   INTEGER NOT NULL DEFAULT 0,
      created_at               INTEGER NOT NULL,
      updated_at               INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_upstream_merge_outbox_state_updated
      ON ${TABLE} (state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_upstream_merge_outbox_approval
      ON ${TABLE} (approval_id);
  `);

  // D-138 P5 fold-back — pre-launch zero-migration discipline. Older
  // dev databases land without the new columns; ALTER guarded by
  // `PRAGMA table_info` keeps fresh boots and existing dev databases
  // converging on the same shape.
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(${TABLE})`).all() as { name: string }[])
      .map((r) => r.name),
  );
  if (!cols.has('connection_name')) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN connection_name TEXT`);
  }
  if (!cols.has('same_user_auto_approve')) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN same_user_auto_approve INTEGER NOT NULL DEFAULT 0`);
  }
};

interface OutboxRowDb {
  id: string;
  approval_id: string;
  vendor: string;
  object_type: string;
  candidate_ids: string;
  survivor_email: string;
  loser_emails: string;
  vendor_pairs: string;
  idempotency_key: string;
  state: string;
  attempts: number;
  last_attempt_at: number | null;
  pre_merge_snapshot: string | null;
  last_error: string | null;
  connection_name: string | null;
  same_user_auto_approve: number;
  created_at: number;
  updated_at: number;
}

const rowToShape = (row: OutboxRowDb): UpstreamMergeOutboxRow => {
  const out: UpstreamMergeOutboxRow = {
    id: row.id,
    approval_id: row.approval_id,
    vendor: row.vendor as UpstreamMergeVendor,
    object_type: row.object_type as UpstreamMergeObjectType,
    candidate_ids: JSON.parse(row.candidate_ids) as string[],
    survivor_email: row.survivor_email,
    loser_emails: JSON.parse(row.loser_emails) as string[],
    vendor_pairs: JSON.parse(row.vendor_pairs) as UpstreamMergeVendorPair[],
    idempotency_key: row.idempotency_key,
    state: row.state as UpstreamMergeState,
    attempts: row.attempts,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.last_attempt_at !== null) out.last_attempt_at = row.last_attempt_at;
  if (row.pre_merge_snapshot !== null) {
    out.pre_merge_snapshot = JSON.parse(row.pre_merge_snapshot) as Record<string, unknown>;
  }
  if (row.last_error !== null) {
    out.last_error = JSON.parse(row.last_error) as UpstreamMergeError;
  }
  if (row.connection_name !== null) out.connection_name = row.connection_name;
  out.same_user_auto_approve = row.same_user_auto_approve === 1;
  return out;
};

export interface UpstreamMergeStore {
  insert(row: UpstreamMergeOutboxRow): UpstreamMergeOutboxRow;
  /** Idempotent insert — if a row with the same `idempotency_key`
   *  already exists, returns the existing row instead of throwing. */
  insertIfAbsent(row: UpstreamMergeOutboxRow): {
    row: UpstreamMergeOutboxRow;
    inserted: boolean;
  };
  get(id: string): UpstreamMergeOutboxRow | null;
  getByIdempotencyKey(key: string): UpstreamMergeOutboxRow | null;
  list(query?: { state?: UpstreamMergeState; limit?: number }): UpstreamMergeOutboxRow[];
  /** Apply a state-machine event + persist. Throws on invalid
   *  transition. Returns the row in its post-transition state. */
  applyEvent(
    id: string,
    event: UpstreamMergeEvent,
    patch?: {
      attempts_delta?: number;
      last_error?: UpstreamMergeError | null;
      pre_merge_snapshot?: Record<string, unknown>;
      mark_attempt?: boolean;
    },
  ): UpstreamMergeOutboxRow;
  /** Server-boot recovery sweep — returns every row in a recoverable
   *  state ordered by `updated_at ASC` so the driver replays them in
   *  fairness order. */
  listRecoverable(): UpstreamMergeOutboxRow[];
  delete(id: string): boolean;
}

export const createUpstreamMergeStore = (
  db: Database.Database,
  now: () => number = Date.now,
): UpstreamMergeStore => {
  ensureUpstreamMergeOutboxSchema(db);

  const insertStmt = db.prepare(`
    INSERT INTO ${TABLE} (
      id, approval_id, vendor, object_type, candidate_ids, survivor_email,
      loser_emails, vendor_pairs, idempotency_key, state, attempts,
      last_attempt_at, pre_merge_snapshot, last_error,
      connection_name, same_user_auto_approve,
      created_at, updated_at
    ) VALUES (
      @id, @approval_id, @vendor, @object_type, @candidate_ids, @survivor_email,
      @loser_emails, @vendor_pairs, @idempotency_key, @state, @attempts,
      @last_attempt_at, @pre_merge_snapshot, @last_error,
      @connection_name, @same_user_auto_approve,
      @created_at, @updated_at
    )
  `);

  const selectByIdStmt = db.prepare(
    `SELECT * FROM ${TABLE} WHERE id = ?`,
  );

  const selectByIdempotencyKeyStmt = db.prepare(
    `SELECT * FROM ${TABLE} WHERE idempotency_key = ?`,
  );

  const listAllStmt = db.prepare(
    `SELECT * FROM ${TABLE} ORDER BY updated_at DESC LIMIT ?`,
  );

  const listByStateStmt = db.prepare(
    `SELECT * FROM ${TABLE} WHERE state = ? ORDER BY updated_at DESC LIMIT ?`,
  );

  // D-138 P5 fold-back (Codex F3) — recovery sweep widens to include
  // `pending_vendor_merge` rows that carry `same_user_auto_approve = 1`.
  // A crash between request-rpc insert + first dispatch leaves an
  // approved row pending; without this widening it would stay stuck
  // forever. Multi-surface approvals (`same_user_auto_approve = 0`)
  // remain blocked until the gossip protocol resolves them.
  const listRecoverableStmt = db.prepare(
    `SELECT * FROM ${TABLE}
       WHERE state IN ('vendor_merge_in_flight', 'vendor_merge_succeeded', 'vendor_merge_local_pending')
          OR (state = 'pending_vendor_merge' AND same_user_auto_approve = 1)
       ORDER BY updated_at ASC`,
  );

  const updateStateStmt = db.prepare(`
    UPDATE ${TABLE}
       SET state              = @state,
           attempts           = @attempts,
           last_attempt_at    = @last_attempt_at,
           pre_merge_snapshot = @pre_merge_snapshot,
           last_error         = @last_error,
           updated_at         = @updated_at
     WHERE id = @id
  `);

  const deleteStmt = db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`);

  const serializeRow = (row: UpstreamMergeOutboxRow): Record<string, unknown> => ({
    id: row.id,
    approval_id: row.approval_id,
    vendor: row.vendor,
    object_type: row.object_type,
    candidate_ids: JSON.stringify(row.candidate_ids),
    survivor_email: row.survivor_email,
    loser_emails: JSON.stringify(row.loser_emails),
    vendor_pairs: JSON.stringify(row.vendor_pairs),
    idempotency_key: row.idempotency_key,
    state: row.state,
    attempts: row.attempts,
    last_attempt_at: row.last_attempt_at ?? null,
    pre_merge_snapshot:
      row.pre_merge_snapshot !== undefined ? JSON.stringify(row.pre_merge_snapshot) : null,
    last_error: row.last_error !== undefined ? JSON.stringify(row.last_error) : null,
    connection_name: row.connection_name ?? null,
    same_user_auto_approve: row.same_user_auto_approve === true ? 1 : 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });

  const insert = (row: UpstreamMergeOutboxRow): UpstreamMergeOutboxRow => {
    insertStmt.run(serializeRow(row));
    return row;
  };

  const insertIfAbsent = (
    row: UpstreamMergeOutboxRow,
  ): { row: UpstreamMergeOutboxRow; inserted: boolean } => {
    const existing = selectByIdempotencyKeyStmt.get(row.idempotency_key) as
      | OutboxRowDb
      | undefined;
    if (existing) {
      return { row: rowToShape(existing), inserted: false };
    }
    insertStmt.run(serializeRow(row));
    return { row, inserted: true };
  };

  const get = (id: string): UpstreamMergeOutboxRow | null => {
    const found = selectByIdStmt.get(id) as OutboxRowDb | undefined;
    return found ? rowToShape(found) : null;
  };

  const getByIdempotencyKey = (key: string): UpstreamMergeOutboxRow | null => {
    const found = selectByIdempotencyKeyStmt.get(key) as OutboxRowDb | undefined;
    return found ? rowToShape(found) : null;
  };

  const list = (
    query?: { state?: UpstreamMergeState; limit?: number },
  ): UpstreamMergeOutboxRow[] => {
    const limit = Math.max(1, Math.min(query?.limit ?? 100, 500));
    const rows = (
      query?.state !== undefined
        ? (listByStateStmt.all(query.state, limit) as OutboxRowDb[])
        : (listAllStmt.all(limit) as OutboxRowDb[])
    );
    return rows.map(rowToShape);
  };

  const applyEvent = (
    id: string,
    event: UpstreamMergeEvent,
    patch?: {
      attempts_delta?: number;
      last_error?: UpstreamMergeError | null;
      pre_merge_snapshot?: Record<string, unknown>;
      mark_attempt?: boolean;
    },
  ): UpstreamMergeOutboxRow => {
    const current = get(id);
    if (current === null) {
      throw new Error(`upstream_merge_outbox: row ${id} not found`);
    }
    const nextState = nextUpstreamMergeState(current.state, event);
    const nextAttempts =
      patch?.attempts_delta !== undefined
        ? current.attempts + patch.attempts_delta
        : current.attempts;
    const nowMs = now();
    const nextLastError =
      patch?.last_error === null
        ? undefined
        : patch?.last_error !== undefined
          ? patch.last_error
          : current.last_error;
    const nextSnapshot =
      patch?.pre_merge_snapshot !== undefined
        ? patch.pre_merge_snapshot
        : current.pre_merge_snapshot;

    updateStateStmt.run({
      id,
      state: nextState,
      attempts: nextAttempts,
      last_attempt_at: patch?.mark_attempt ? nowMs : current.last_attempt_at ?? null,
      pre_merge_snapshot:
        nextSnapshot !== undefined ? JSON.stringify(nextSnapshot) : null,
      last_error: nextLastError !== undefined ? JSON.stringify(nextLastError) : null,
      updated_at: nowMs,
    });

    const updated = get(id);
    if (updated === null) {
      throw new Error(`upstream_merge_outbox: row ${id} disappeared after update`);
    }
    return updated;
  };

  const listRecoverable = (): UpstreamMergeOutboxRow[] => {
    const rows = listRecoverableStmt.all() as OutboxRowDb[];
    // Defensive — assert each row matches the recoverable predicate
    // AND, for pending rows, the `same_user_auto_approve` flag (the
    // SQL filter already enforces this; the in-process check is the
    // belt-and-braces guard against future schema drift).
    return rows.map(rowToShape).filter((r) => {
      if (!isUpstreamMergeRecoverable(r.state)) return false;
      if (r.state === 'pending_vendor_merge') return r.same_user_auto_approve === true;
      return true;
    });
  };

  const del = (id: string): boolean => {
    const result = deleteStmt.run(id);
    return result.changes > 0;
  };

  return {
    insert,
    insertIfAbsent,
    get,
    getByIdempotencyKey,
    list,
    applyEvent,
    listRecoverable,
    delete: del,
  };
};

// re-export utility predicate so callers don't double-import.
export { isUpstreamMergeTerminal };
