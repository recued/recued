/** D-125 Phase 1.2 — connection substrate SQLite storage (server).
 *
 *  The authoritative `connections` table has composite PRIMARY KEY
 *  `(kind, name)` plus two indexes (`updated_at` for sync delta queries and
 *  `kind` for facet listing). A separate secret-free rotation-attempt table
 *  lets a paired client reconcile a verify-before-swap request whose reply was
 *  lost to a reload or reconnect.
 *
 *  `auth_json` is AEAD ciphertext, base64-encoded; `config_json` and
 *  `health_json` are plaintext JSON. The store stays opaque to the
 *  ciphertext — the D-125 P3 adapter is the only code path that
 *  decrypts at call time.
 *
 *  Read paths surface `ConnectionRow` directly. The contracts-side
 *  `connectionViewFromRow` helper projects rows to the resolver's
 *  read-only `ConnectionView` (auth excluded by construction).
 *
 *  No rpc, no enrollment UX, no probe — those land in P2.x. P1.2
 *  ships the schema + a thin store interface that future phases
 *  layer on top of. */

import type Database from 'better-sqlite3';
import {
  type ConnectionAuthType,
  type ConnectionCredentialRejectionResolution,
  type ConnectionCredentialRotationFailureReason,
  type ConnectionCredentialRejectionTriageStage,
  type ConnectionCredentialVerification,
  type ConnectionKind,
  type ConnectionRow,
  connectionRowKey,
} from '@recued/contracts';

const CONNECTION_TABLE = 'connections';
const CREDENTIAL_ROTATION_ATTEMPT_TABLE =
  'connection_credential_rotation_attempts';

/** Install the connections table + indexes. Idempotent — every
 *  statement uses `IF NOT EXISTS`. Safe to call on every boot. */
export const ensureConnectionSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CONNECTION_TABLE} (
      name             TEXT NOT NULL,
      kind             TEXT NOT NULL CHECK (kind IN ('mcp', 'api', 'notification')),
      subtype          TEXT,
      display_name     TEXT NOT NULL,
      publisher_id     TEXT,
      config_json      TEXT NOT NULL,
      auth_json        TEXT NOT NULL,
      enrolled_at      INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      last_used_at     INTEGER,
      health_json      TEXT,
      subresource_path TEXT,
      granted_scopes_json TEXT,
      PRIMARY KEY (kind, name)
    );
    CREATE INDEX IF NOT EXISTS idx_connections_updated_at
      ON ${CONNECTION_TABLE} (updated_at);
    CREATE INDEX IF NOT EXISTS idx_connections_kind
      ON ${CONNECTION_TABLE} (kind);

    CREATE TABLE IF NOT EXISTS ${CREDENTIAL_ROTATION_ATTEMPT_TABLE} (
      attempt_id       TEXT PRIMARY KEY,
      kind             TEXT NOT NULL CHECK (kind IN ('mcp', 'api', 'notification')),
      name             TEXT NOT NULL,
      status           TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
      started_at       INTEGER NOT NULL,
      finished_at      INTEGER,
      verified_at      INTEGER,
      auth_type        TEXT CHECK (
        auth_type IS NULL OR auth_type IN (
          'none', 'bearer', 'basic', 'header', 'query',
          'oauth2_refresh', 'oauth2_client_credentials', 'atproto_session'
        )
      ),
      access_expires_at INTEGER,
      failure_reason   TEXT CHECK (
        failure_reason IS NULL OR failure_reason IN (
          'auth_failed', 'unreachable', 'inconclusive', 'conflict', 'server_error'
        )
      ),
      auth_rejection_triage_stage TEXT CHECK (
        auth_rejection_triage_stage IS NULL OR auth_rejection_triage_stage IN (
          'credential_exchange', 'provider_probe'
        )
      ),
      auth_rejection_resolution TEXT CHECK (
        auth_rejection_resolution IS NULL OR auth_rejection_resolution =
          'regenerate_credential_or_contact_admin'
      ),
      safe_stop_acknowledged_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_connection_credential_rotation_finished
      ON ${CREDENTIAL_ROTATION_ATTEMPT_TABLE} (finished_at);
    CREATE INDEX IF NOT EXISTS idx_connection_credential_rotation_identity
      ON ${CREDENTIAL_ROTATION_ATTEMPT_TABLE} (kind, name);
  `);

  // D-165 P3.path-picker — additive column for tables created before the
  // field existed. `CREATE TABLE IF NOT EXISTS` won't widen an existing
  // table, so guard with PRAGMA table_info (same idiom as the enrichment
  // store's D-128/D-136 column adds). Nullable — legacy rows read back as
  // an absent path, defaulted to `/` by `canonicalizeSubresourcePath`.
  const cols = db
    .prepare(`PRAGMA table_info(${CONNECTION_TABLE})`)
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === 'subresource_path')) {
    db.exec(`ALTER TABLE ${CONNECTION_TABLE} ADD COLUMN subresource_path TEXT`);
  }
  // granted-scopes — additive nullable column for tables created before the
  // field existed (same PRAGMA-guarded idiom as subresource_path above).
  // Legacy rows read back as an absent set → "unknown coverage".
  if (!cols.some((c) => c.name === 'granted_scopes_json')) {
    db.exec(`ALTER TABLE ${CONNECTION_TABLE} ADD COLUMN granted_scopes_json TEXT`);
  }
  const attemptCols = db
    .prepare(`PRAGMA table_info(${CREDENTIAL_ROTATION_ATTEMPT_TABLE})`)
    .all() as { name: string }[];
  if (!attemptCols.some((c) => c.name === 'auth_rejection_triage_stage')) {
    db.exec(`ALTER TABLE ${CREDENTIAL_ROTATION_ATTEMPT_TABLE}
      ADD COLUMN auth_rejection_triage_stage TEXT CHECK (
        auth_rejection_triage_stage IS NULL OR auth_rejection_triage_stage IN (
          'credential_exchange', 'provider_probe'
        )
      )`);
  }
  if (!attemptCols.some((c) => c.name === 'auth_rejection_resolution')) {
    db.exec(`ALTER TABLE ${CREDENTIAL_ROTATION_ATTEMPT_TABLE}
      ADD COLUMN auth_rejection_resolution TEXT CHECK (
        auth_rejection_resolution IS NULL OR auth_rejection_resolution =
          'regenerate_credential_or_contact_admin'
      )`);
  }
  if (!attemptCols.some((c) => c.name === 'safe_stop_acknowledged_at')) {
    db.exec(`ALTER TABLE ${CREDENTIAL_ROTATION_ATTEMPT_TABLE}
      ADD COLUMN safe_stop_acknowledged_at INTEGER`);
  }
};

interface ConnectionDbRow {
  name: string;
  kind: ConnectionKind;
  subtype: string | null;
  display_name: string;
  publisher_id: string | null;
  config_json: string;
  auth_json: string;
  enrolled_at: number;
  updated_at: number;
  last_used_at: number | null;
  health_json: string | null;
  subresource_path: string | null;
  granted_scopes_json: string | null;
}

const dbRowToConnectionRow = (row: ConnectionDbRow): ConnectionRow => {
  const out: ConnectionRow = {
    pk: connectionRowKey(row.kind, row.name),
    kind: row.kind,
    name: row.name,
    display_name: row.display_name,
    config_json: row.config_json,
    auth_ciphertext: row.auth_json,
    enrolled_at: row.enrolled_at,
    updated_at: row.updated_at,
  };
  if (row.subtype !== null) out.subtype = row.subtype;
  if (row.publisher_id !== null) out.publisher_id = row.publisher_id;
  if (row.last_used_at !== null) out.last_used_at = row.last_used_at;
  if (row.health_json !== null) out.health_json = row.health_json;
  if (row.subresource_path !== null) out.subresource_path = row.subresource_path;
  if (row.granted_scopes_json !== null) out.granted_scopes_json = row.granted_scopes_json;
  return out;
};

/** Resolve a connection row's declared VENDOR — the SINGLE source of truth shared
 *  by the catalog grant-write path (`connection-handler.ts` — the grant rpcs +
 *  the D-136 delete cascade) and the operation-profile seed
 *  (`connection-operation-profile-boot.ts`). The two MUST agree: the D-165 P3.grant
 *  migration keys `contract.grant` rows on the vendor's catalog slug, so a row the
 *  WRITE path resolves to a vendor but the SEED path does not (or vice versa) lands
 *  a grant under a slug the reseed never reads — stranding it (fail-closed: the
 *  write→ask path silently reverts to deny after a token-refresh reseed). One
 *  resolver keeps them in lock-step.
 *
 *  `config_json.vendor` first (the canonical field every vendor reconciler reads),
 *  then the `subtype` column as a fallback for api rows that carried the vendor
 *  there. Returns undefined when neither is a non-empty string. Kind-agnostic —
 *  callers gate `kind: 'api'`. */
export const resolveConnectionVendor = (
  row: { config_json: string; subtype?: string | null },
): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(row.config_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const vendor = (parsed as Record<string, unknown>).vendor;
      if (typeof vendor === 'string' && vendor.length > 0) return vendor;
    }
  } catch {
    /* bad JSON → no vendor declared */
  }
  if (typeof row.subtype === 'string' && row.subtype.length > 0) return row.subtype;
  return undefined;
};

/** Per-write input. The store never sees a parsed `ConnectionAuth`
 *  — callers pass the already-encrypted `auth_ciphertext` so the
 *  encryption pipeline stays adapter-internal. */
export interface ConnectionUpsert {
  kind: ConnectionKind;
  name: string;
  subtype?: string;
  display_name: string;
  publisher_id?: string;
  config_json: string;
  auth_ciphertext: string;
  enrolled_at: number;
  updated_at: number;
  last_used_at?: number;
  health_json?: string;
  /** D-165 P3.path-picker — canonicalized sub-resource scope. Absent →
   *  NULL column (legacy/whole-account; consumers default to `/`). The
   *  handler canonicalizes before calling, so the store persists the
   *  value verbatim. */
  subresource_path?: string;
  /** granted-scopes — JSON-array TEXT of the vendor-granted OAuth scopes.
   *  Absent → NULL column ("unknown coverage"). The handler stringifies
   *  before calling; the store persists verbatim. Carry it forward on
   *  every non-enroll restamp (refresh / probe / patch) — dropping it
   *  silently flips a covered connection to "needs re-auth". */
  granted_scopes_json?: string;
}

/** Durable lifecycle row for one owner-started credential replacement. It is
 * intentionally incapable of carrying credential material or raw provider
 * errors. */
export type ConnectionCredentialRotationAttemptRow =
  | {
      attempt_id: string;
      kind: ConnectionKind;
      name: string;
      status: 'pending';
      started_at: number;
    }
  | {
      attempt_id: string;
      kind: ConnectionKind;
      name: string;
      status: 'succeeded';
      started_at: number;
      verification: ConnectionCredentialVerification;
    }
  | {
      attempt_id: string;
      kind: ConnectionKind;
      name: string;
      status: 'failed';
      started_at: number;
      finished_at: number;
      failure_reason: ConnectionCredentialRotationFailureReason;
      /** Safe discriminator retained only to reconstruct the exact form
       * correction handoff after a reload; no credential value is stored. */
      auth_type?: ConnectionAuthType;
      /** Present only when the immediately preceding terminal attempt for this
       * connection was also an auth rejection. */
      auth_rejection_triage_stage?: ConnectionCredentialRejectionTriageStage;
      /** Present only when this rejection follows an already-triaged
       * rejection, making another unchanged retry an unsafe default. */
      auth_rejection_resolution?: ConnectionCredentialRejectionResolution;
      /** Explicit paired-server closure for this exact safe stop. A later
       * attempt supersedes the row regardless; this timestamp prevents cold
       * clients from rediscovering an already acknowledged handoff. */
      safe_stop_acknowledged_at?: number;
    };

interface CredentialRotationAttemptDbRow {
  attempt_id: string;
  kind: ConnectionKind;
  name: string;
  status: 'pending' | 'succeeded' | 'failed';
  started_at: number;
  finished_at: number | null;
  verified_at: number | null;
  auth_type: ConnectionAuthType | null;
  access_expires_at: number | null;
  failure_reason: ConnectionCredentialRotationFailureReason | null;
  auth_rejection_triage_stage: ConnectionCredentialRejectionTriageStage | null;
  auth_rejection_resolution: ConnectionCredentialRejectionResolution | null;
  safe_stop_acknowledged_at: number | null;
}

const dbRowToCredentialRotationAttempt = (
  row: CredentialRotationAttemptDbRow,
): ConnectionCredentialRotationAttemptRow => {
  const identity = {
    attempt_id: row.attempt_id,
    kind: row.kind,
    name: row.name,
    started_at: row.started_at,
  };
  if (row.status === 'pending') return { ...identity, status: 'pending' };
  if (
    row.status === 'succeeded'
    && row.verified_at !== null
    && row.auth_type !== null
  ) {
    return {
      ...identity,
      status: 'succeeded',
      verification: {
        status: 'verified',
        verified_at: row.verified_at,
        auth_type: row.auth_type,
        ...(row.access_expires_at !== null
          ? { access_expires_at: row.access_expires_at }
          : {}),
      },
    };
  }
  if (
    row.status === 'failed'
    && row.finished_at !== null
    && row.failure_reason !== null
  ) {
    return {
      ...identity,
      status: 'failed',
      finished_at: row.finished_at,
      failure_reason: row.failure_reason,
      ...(row.auth_type !== null ? { auth_type: row.auth_type } : {}),
      ...(row.auth_rejection_triage_stage !== null
        ? { auth_rejection_triage_stage: row.auth_rejection_triage_stage }
        : {}),
      ...(row.auth_rejection_resolution !== null
        ? { auth_rejection_resolution: row.auth_rejection_resolution }
        : {}),
      ...(row.safe_stop_acknowledged_at !== null
        ? { safe_stop_acknowledged_at: row.safe_stop_acknowledged_at }
        : {}),
    };
  }
  throw new Error(`invalid credential rotation attempt '${row.attempt_id}'`);
};

export interface ConnectionStoreSqlite {
  /** Upsert by composite key. Fully replaces the row when present.
   *  LWW semantics live one layer up at the sync wire (P2.2); this
   *  store always honors the caller's `updated_at`. */
  upsert(input: ConnectionUpsert): ConnectionRow;
  /** Fetch by composite key or null when absent. */
  get(kind: ConnectionKind, name: string): ConnectionRow | null;
  /** List every row, optionally filtered by kind. Newest `updated_at`
   *  first — drives the Settings → Connections list and the sync
   *  delta scan. */
  list(query?: { kind?: ConnectionKind }): ConnectionRow[];
  /** List rows with `updated_at > since` for sync delta scans
   *  (P2.2 cloud sync wire). Newest first. */
  listSince(since: number): ConnectionRow[];
  /** Delete by composite key. Returns true when a row was removed. */
  delete(kind: ConnectionKind, name: string): boolean;
  /** Total row count — Settings page header. */
  count(): number;
  /** D-232 § 22 — write ONLY the health column for one connection.
   *
   *  ⛔⛔ NOT `upsert`, AND THE DIFFERENCE IS A LOST CREDENTIAL. `upsert` fully
   *  replaces the row, so a health write built as read-modify-write would race
   *  the OAuth refresh path: refresh rotates `auth_ciphertext`, a dispatch that
   *  read the row moments earlier writes its stale copy back, and the rotated
   *  refresh token is gone. Health is written on EVERY dispatch, so that race
   *  would be run constantly rather than rarely.
   *
   *  Returns false when no such row exists (deleted mid-dispatch) — the caller
   *  treats health as best-effort and never fails a call over it. */
  setHealth(kind: ConnectionKind, name: string, health_json: string): boolean;
  /** Claim an idempotency key before any provider I/O. Optional on the broad
   * interface so narrowly hand-built read-only test stores remain valid; the
   * production SQLite store always implements the complete recovery quartet. */
  claimCredentialRotationAttempt?(input: {
    attempt_id: string;
    kind: ConnectionKind;
    name: string;
    started_at: number;
  }): { claimed: boolean; attempt: ConnectionCredentialRotationAttemptRow };
  getCredentialRotationAttempt?(
    attempt_id: string,
  ): ConnectionCredentialRotationAttemptRow | null;
  /** Read the one server-owned provider check for an exact connection. The
   * production store enforces at most one pending row per kind/name. */
  getPendingCredentialRotationAttempt?(
    kind: ConnectionKind,
    name: string,
  ): ConnectionCredentialRotationAttemptRow | null;
  /** Latest claim for an exact connection in causal insertion order. Used by
   * the secret-free activity read to project a still-current safe stop without
   * exposing its opaque attempt id. */
  getLatestCredentialRotationAttempt?(
    kind: ConnectionKind,
    name: string,
  ): ConnectionCredentialRotationAttemptRow | null;
  /** Enumerate only current, unacknowledged safe stops, newest causal claim
   * first. Returned rows contain closed-list metadata only. */
  listCredentialRotationSafeStops?(query?: {
    kind?: ConnectionKind;
  }): Array<Extract<
    ConnectionCredentialRotationAttemptRow,
    { status: 'failed' }
  >>;
  /** Enumerate only latest safe stops that the paired server already
   * acknowledged. The list handler combines these secret-free rows with the
   * connection's persisted health to restore unresolved post-ack checks. */
  listAcknowledgedCredentialRotationSafeStops?(query?: {
    kind?: ConnectionKind;
  }): Array<Extract<
    ConnectionCredentialRotationAttemptRow,
    { status: 'failed' }
  > & { safe_stop_acknowledged_at: number }>;
  /** Compare-and-set closure for one exact safe-stop row. The attempt must
   * still be the latest claim for its connection; otherwise null is returned. */
  acknowledgeCredentialRotationSafeStop?(input: {
    attempt_id: string;
    kind: ConnectionKind;
    name: string;
    acknowledged_at: number;
  }): {
    status: 'acknowledged' | 'already_acknowledged';
    attempt: Extract<
      ConnectionCredentialRotationAttemptRow,
      { status: 'failed' }
    > & { safe_stop_acknowledged_at: number };
  } | null;
  /** Commit the replacement row and its success receipt atomically. */
  completeCredentialRotationAttempt?(input: {
    attempt_id: string;
    connection: ConnectionUpsert;
    verification: ConnectionCredentialVerification;
  }): ConnectionRow;
  /** Close a claimed attempt after a safe pre-commit failure. */
  failCredentialRotationAttempt?(input: {
    attempt_id: string;
    finished_at: number;
    reason: ConnectionCredentialRotationFailureReason;
    /** Non-secret discriminator used only for an auth-rejection correction
     * receipt. Omit when no candidate auth shape was established. */
    auth_type?: ConnectionAuthType;
    /** Bounded stage for this auth rejection. The store persists it only when
     * the prior terminal attempt was also an auth rejection. */
    auth_rejection_stage?: ConnectionCredentialRejectionTriageStage;
  }): ConnectionCredentialRotationAttemptRow;
  /** D-130 P2 — register a post-mutation hook fired after every
   *  successful `upsert` (enrollment / update / probe / refresh). Each
   *  vendor reconciliation boot wire installs its own handler keyed by
   *  vendor filter, so HubSpot + Salesforce + future-vendor wires
   *  coexist on the same store. Returns an unsubscribe callback —
   *  tests + module reload paths can drop a handler without affecting
   *  others. Handlers fire in registration order; exceptions are
   *  swallowed per-handler so a buggy registration never breaks the
   *  rpc that triggered the mutation. (D-129 P2 shipped a single-
   *  handler `setOnUpsert`; D-130 P2 widened to additive registration
   *  to let multiple vendor wires coexist.) */
  addOnUpsert(handler: (row: ConnectionRow) => void): () => void;
  /** D-130 P2 — register a post-mutation hook fired after every
   *  successful `delete`. Mirrors `addOnUpsert`'s additive shape. */
  addOnDelete(
    handler: (kind: ConnectionKind, name: string) => void,
  ): () => void;
  /** Register a synchronous transaction-critical hook that runs before a
   * present row is deleted. The hook must return `undefined`; the hook and
   * exact one-row connection deletion share one SQLite transaction. Any hook
   * exception, asynchronous return, or premature target-row removal rolls back every
   * hook mutation and preserves the connection. Use this only for fail-close
   * invariants that must be durable before the authority row disappears.
   * Ordinary cleanup belongs in `addOnDelete`. */
  addBeforeDelete(
    handler: (kind: ConnectionKind, name: string) => undefined,
  ): () => void;
}

export const createConnectionStore = (
  db: Database.Database,
): ConnectionStoreSqlite => {
  ensureConnectionSchema(db);

  // A live handler claims before provider I/O and closes the row in the same
  // process. Therefore a persisted pending row observed while constructing the
  // boot store can only belong to an interrupted prior process. The connection
  // swap and success receipt are one transaction, so closing it as failed is
  // safe: no replacement from that attempt can have landed.
  db.prepare(`
    UPDATE ${CREDENTIAL_ROTATION_ATTEMPT_TABLE}
       SET status = 'failed',
           finished_at = ?,
           failure_reason = 'server_error',
           auth_rejection_triage_stage = NULL,
           auth_rejection_resolution = NULL
     WHERE status = 'pending'
  `).run(Date.now());

  // Older builds allowed distinct attempt ids for the same connection to be
  // pending concurrently. Boot has just closed every orphaned pending row, so
  // the partial unique index can be installed safely even on those databases.
  // It is the final authority behind the browser's advisory Web Lock: another
  // origin/client/process still cannot start duplicate provider I/O.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_connection_credential_rotation_pending_owner
      ON ${CREDENTIAL_ROTATION_ATTEMPT_TABLE} (kind, name)
      WHERE status = 'pending'
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO ${CONNECTION_TABLE}
      (name, kind, subtype, display_name, publisher_id, config_json,
       auth_json, enrolled_at, updated_at, last_used_at, health_json,
       subresource_path, granted_scopes_json)
      VALUES
      (@name, @kind, @subtype, @display_name, @publisher_id, @config_json,
       @auth_json, @enrolled_at, @updated_at, @last_used_at, @health_json,
       @subresource_path, @granted_scopes_json)
    ON CONFLICT (kind, name) DO UPDATE SET
      subtype          = excluded.subtype,
      display_name     = excluded.display_name,
      publisher_id     = excluded.publisher_id,
      config_json      = excluded.config_json,
      auth_json        = excluded.auth_json,
      enrolled_at      = excluded.enrolled_at,
      updated_at       = excluded.updated_at,
      last_used_at     = excluded.last_used_at,
      health_json      = excluded.health_json,
      subresource_path = excluded.subresource_path,
      granted_scopes_json = excluded.granted_scopes_json
  `);

  const getStmt = db.prepare(
    `SELECT * FROM ${CONNECTION_TABLE} WHERE kind = ? AND name = ?`,
  );
  const listAllStmt = db.prepare(
    `SELECT * FROM ${CONNECTION_TABLE} ORDER BY updated_at DESC, name ASC`,
  );
  const listByKindStmt = db.prepare(
    `SELECT * FROM ${CONNECTION_TABLE}
       WHERE kind = ?
       ORDER BY updated_at DESC, name ASC`,
  );
  const listSinceStmt = db.prepare(
    `SELECT * FROM ${CONNECTION_TABLE}
       WHERE updated_at > ?
       ORDER BY updated_at DESC, name ASC`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM ${CONNECTION_TABLE} WHERE kind = ? AND name = ?`,
  );
  const deleteCredentialRotationAttemptsForConnectionStmt = db.prepare(
    `DELETE FROM ${CREDENTIAL_ROTATION_ATTEMPT_TABLE} WHERE kind = ? AND name = ?`,
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM ${CONNECTION_TABLE}`);
  const claimCredentialRotationStmt = db.prepare(`
    INSERT INTO ${CREDENTIAL_ROTATION_ATTEMPT_TABLE}
      (attempt_id, kind, name, status, started_at)
    VALUES (?, ?, ?, 'pending', ?)
    ON CONFLICT (attempt_id) DO NOTHING
  `);
  const getCredentialRotationStmt = db.prepare(
    `SELECT * FROM ${CREDENTIAL_ROTATION_ATTEMPT_TABLE} WHERE attempt_id = ?`,
  );
  const getPendingCredentialRotationForConnectionStmt = db.prepare(`
    SELECT * FROM ${CREDENTIAL_ROTATION_ATTEMPT_TABLE}
     WHERE kind = ? AND name = ? AND status = 'pending'
  `);
  const getLatestCredentialRotationForConnectionStmt = db.prepare(`
    SELECT * FROM ${CREDENTIAL_ROTATION_ATTEMPT_TABLE}
     WHERE kind = ? AND name = ?
     ORDER BY rowid DESC
     LIMIT 1
  `);
  const listCredentialRotationSafeStopsStmt = db.prepare(`
    SELECT attempt.*
      FROM ${CREDENTIAL_ROTATION_ATTEMPT_TABLE} AS attempt
      JOIN ${CONNECTION_TABLE} AS connection
        ON connection.kind = attempt.kind
       AND connection.name = attempt.name
     WHERE attempt.status = 'failed'
       AND attempt.failure_reason = 'auth_failed'
       AND attempt.auth_type IS NOT NULL
       AND attempt.auth_rejection_resolution =
         'regenerate_credential_or_contact_admin'
       AND attempt.safe_stop_acknowledged_at IS NULL
       AND attempt.rowid = (
         SELECT MAX(latest.rowid)
           FROM ${CREDENTIAL_ROTATION_ATTEMPT_TABLE} AS latest
          WHERE latest.kind = attempt.kind
            AND latest.name = attempt.name
       )
     ORDER BY attempt.rowid DESC
  `);
  const listCredentialRotationSafeStopsByKindStmt = db.prepare(`
    SELECT attempt.*
      FROM ${CREDENTIAL_ROTATION_ATTEMPT_TABLE} AS attempt
      JOIN ${CONNECTION_TABLE} AS connection
        ON connection.kind = attempt.kind
       AND connection.name = attempt.name
     WHERE attempt.kind = ?
       AND attempt.status = 'failed'
       AND attempt.failure_reason = 'auth_failed'
       AND attempt.auth_type IS NOT NULL
       AND attempt.auth_rejection_resolution =
         'regenerate_credential_or_contact_admin'
       AND attempt.safe_stop_acknowledged_at IS NULL
       AND attempt.rowid = (
         SELECT MAX(latest.rowid)
           FROM ${CREDENTIAL_ROTATION_ATTEMPT_TABLE} AS latest
          WHERE latest.kind = attempt.kind
            AND latest.name = attempt.name
       )
     ORDER BY attempt.rowid DESC
  `);
  const listAcknowledgedCredentialRotationSafeStopsStmt = db.prepare(`
    SELECT attempt.*
      FROM ${CREDENTIAL_ROTATION_ATTEMPT_TABLE} AS attempt
      JOIN ${CONNECTION_TABLE} AS connection
        ON connection.kind = attempt.kind
       AND connection.name = attempt.name
     WHERE attempt.status = 'failed'
       AND attempt.failure_reason = 'auth_failed'
       AND attempt.auth_type IS NOT NULL
       AND attempt.auth_rejection_resolution =
         'regenerate_credential_or_contact_admin'
       AND attempt.safe_stop_acknowledged_at IS NOT NULL
       AND attempt.rowid = (
         SELECT MAX(latest.rowid)
           FROM ${CREDENTIAL_ROTATION_ATTEMPT_TABLE} AS latest
          WHERE latest.kind = attempt.kind
            AND latest.name = attempt.name
       )
     ORDER BY attempt.rowid DESC
  `);
  const listAcknowledgedCredentialRotationSafeStopsByKindStmt = db.prepare(`
    SELECT attempt.*
      FROM ${CREDENTIAL_ROTATION_ATTEMPT_TABLE} AS attempt
      JOIN ${CONNECTION_TABLE} AS connection
        ON connection.kind = attempt.kind
       AND connection.name = attempt.name
     WHERE attempt.kind = ?
       AND attempt.status = 'failed'
       AND attempt.failure_reason = 'auth_failed'
       AND attempt.auth_type IS NOT NULL
       AND attempt.auth_rejection_resolution =
         'regenerate_credential_or_contact_admin'
       AND attempt.safe_stop_acknowledged_at IS NOT NULL
       AND attempt.rowid = (
         SELECT MAX(latest.rowid)
           FROM ${CREDENTIAL_ROTATION_ATTEMPT_TABLE} AS latest
          WHERE latest.kind = attempt.kind
            AND latest.name = attempt.name
       )
     ORDER BY attempt.rowid DESC
  `);
  // A connection can have only one pending claim, so insertion order is its
  // causal attempt order. Do not rank by caller/injected wall-clock values:
  // a clock rollback could otherwise skip a newer success or non-auth reset.
  const getLatestTerminalCredentialRotationForConnectionStmt = db.prepare(`
    SELECT status, failure_reason, auth_rejection_triage_stage
      FROM ${CREDENTIAL_ROTATION_ATTEMPT_TABLE}
     WHERE kind = ?
       AND name = ?
       AND attempt_id <> ?
       AND status IN ('succeeded', 'failed')
     ORDER BY rowid DESC
     LIMIT 1
  `);
  const completeCredentialRotationStmt = db.prepare(`
    UPDATE ${CREDENTIAL_ROTATION_ATTEMPT_TABLE}
       SET status = 'succeeded',
           finished_at = @verified_at,
           verified_at = @verified_at,
           auth_type = @auth_type,
           access_expires_at = @access_expires_at,
           failure_reason = NULL,
           auth_rejection_triage_stage = NULL,
           auth_rejection_resolution = NULL,
           safe_stop_acknowledged_at = NULL
     WHERE attempt_id = @attempt_id
       AND status = 'pending'
       AND kind = @kind
       AND name = @name
  `);
  const failCredentialRotationStmt = db.prepare(`
    UPDATE ${CREDENTIAL_ROTATION_ATTEMPT_TABLE}
       SET status = 'failed',
           finished_at = @finished_at,
           verified_at = NULL,
           auth_type = @auth_type,
           access_expires_at = NULL,
           failure_reason = @failure_reason,
           auth_rejection_triage_stage = @auth_rejection_triage_stage,
           auth_rejection_resolution = @auth_rejection_resolution,
           safe_stop_acknowledged_at = NULL
     WHERE attempt_id = @attempt_id
       AND status = 'pending'
  `);
  const acknowledgeCredentialRotationSafeStopStmt = db.prepare(`
    UPDATE ${CREDENTIAL_ROTATION_ATTEMPT_TABLE}
       SET safe_stop_acknowledged_at = @acknowledged_at
     WHERE attempt_id = @attempt_id
       AND kind = @kind
       AND name = @name
       AND status = 'failed'
       AND failure_reason = 'auth_failed'
       AND auth_type IS NOT NULL
       AND auth_rejection_resolution =
         'regenerate_credential_or_contact_admin'
       AND safe_stop_acknowledged_at IS NULL
       AND rowid = (
         SELECT MAX(latest.rowid)
           FROM ${CREDENTIAL_ROTATION_ATTEMPT_TABLE} AS latest
          WHERE latest.kind = @kind
            AND latest.name = @name
       )
  `);

  // D-130 P2 — ordinary observers fire post-mutation; exceptions in any
  // handler are swallowed so a buggy reconciliation never breaks the rpc.
  // D-201 9BO's separate pre-delete set is transaction-critical: exceptions
  // propagate and roll back the authority deletion. Sets keep observers
  // additive without clobbering peers.
  const onUpsertHandlers = new Set<(row: ConnectionRow) => void>();
  const onDeleteHandlers = new Set<(kind: ConnectionKind, name: string) => void>();
  const beforeDeleteHandlers = new Set<(
    kind: ConnectionKind,
    name: string,
  ) => undefined>();
  const deleteWithCriticalHooks = db.transaction((
    kind: ConnectionKind,
    name: string,
  ): boolean => {
    if (getStmt.get(kind, name) === undefined) return false;
    for (const handler of beforeDeleteHandlers) {
      if (handler(kind, name) !== undefined) {
        throw new Error('critical before-delete handlers must be synchronous');
      }
    }
    if (deleteStmt.run(kind, name).changes !== 1) {
      throw new Error('connection changed during critical deletion');
    }
    // A later enrollment may reuse the same kind/name but is a new connection
    // incarnation. Retaining an old success receipt would let a stale tab
    // misreport that old credential as active on the replacement row. Keep the
    // receipt cleanup in this transaction so an in-flight old attempt can no
    // longer commit after deletion either.
    deleteCredentialRotationAttemptsForConnectionStmt.run(kind, name);
    return true;
  });

  const upsertParams = (input: ConnectionUpsert) => ({
    name: input.name,
    kind: input.kind,
    subtype: input.subtype ?? null,
    display_name: input.display_name,
    publisher_id: input.publisher_id ?? null,
    config_json: input.config_json,
    auth_json: input.auth_ciphertext,
    enrolled_at: input.enrolled_at,
    updated_at: input.updated_at,
    last_used_at: input.last_used_at ?? null,
    health_json: input.health_json ?? null,
    subresource_path: input.subresource_path ?? null,
    granted_scopes_json: input.granted_scopes_json ?? null,
  });
  const readCredentialRotationAttempt = (
    attemptId: string,
  ): ConnectionCredentialRotationAttemptRow | null => {
    const row = getCredentialRotationStmt.get(attemptId) as
      | CredentialRotationAttemptDbRow
      | undefined;
    return row === undefined ? null : dbRowToCredentialRotationAttempt(row);
  };
  const readPendingCredentialRotationAttempt = (
    kind: ConnectionKind,
    name: string,
  ): ConnectionCredentialRotationAttemptRow | null => {
    const row = getPendingCredentialRotationForConnectionStmt.get(
      kind,
      name,
    ) as CredentialRotationAttemptDbRow | undefined;
    return row === undefined ? null : dbRowToCredentialRotationAttempt(row);
  };
  const claimCredentialRotation = db.transaction((input: {
    attempt_id: string;
    kind: ConnectionKind;
    name: string;
    started_at: number;
  }): { claimed: boolean; attempt: ConnectionCredentialRotationAttemptRow } => {
    const sameAttempt = readCredentialRotationAttempt(input.attempt_id);
    if (sameAttempt !== null) return { claimed: false, attempt: sameAttempt };

    const currentOwner = readPendingCredentialRotationAttempt(
      input.kind,
      input.name,
    );
    if (currentOwner !== null) {
      return { claimed: false, attempt: currentOwner };
    }

    const claimed = claimCredentialRotationStmt.run(
      input.attempt_id,
      input.kind,
      input.name,
      input.started_at,
    ).changes === 1;
    const attempt = readCredentialRotationAttempt(input.attempt_id)
      ?? readPendingCredentialRotationAttempt(input.kind, input.name);
    if (attempt === null) {
      throw new Error('credential rotation claim was not durable');
    }
    return { claimed, attempt };
  });
  const completeCredentialRotation = db.transaction((input: {
    attempt_id: string;
    connection: ConnectionUpsert;
    verification: ConnectionCredentialVerification;
  }): ConnectionRow => {
    const completed = completeCredentialRotationStmt.run({
      attempt_id: input.attempt_id,
      kind: input.connection.kind,
      name: input.connection.name,
      verified_at: input.verification.verified_at,
      auth_type: input.verification.auth_type,
      access_expires_at: input.verification.access_expires_at ?? null,
    });
    if (completed.changes !== 1) {
      throw new Error('credential rotation attempt is no longer pending');
    }
    upsertStmt.run(upsertParams(input.connection));
    return dbRowToConnectionRow(
      getStmt.get(input.connection.kind, input.connection.name) as ConnectionDbRow,
    );
  });
  const failCredentialRotation = db.transaction((input: {
    attempt_id: string;
    finished_at: number;
    reason: ConnectionCredentialRotationFailureReason;
    auth_type?: ConnectionAuthType;
    auth_rejection_stage?: ConnectionCredentialRejectionTriageStage;
  }): ConnectionCredentialRotationAttemptRow => {
    const pending = readCredentialRotationAttempt(input.attempt_id);
    if (pending === null || pending.status !== 'pending') {
      throw new Error('credential rotation attempt is no longer pending');
    }
    const previous = getLatestTerminalCredentialRotationForConnectionStmt.get(
      pending.kind,
      pending.name,
      input.attempt_id,
    ) as {
      status: 'succeeded' | 'failed';
      failure_reason: ConnectionCredentialRotationFailureReason | null;
      auth_rejection_triage_stage:
        ConnectionCredentialRejectionTriageStage | null;
    } | undefined;
    const triageStage = input.reason === 'auth_failed'
      && input.auth_rejection_stage !== undefined
      && previous?.status === 'failed'
      && previous.failure_reason === 'auth_failed'
      ? input.auth_rejection_stage
      : null;
    const resolution: ConnectionCredentialRejectionResolution | null =
      triageStage !== null
      && previous?.status === 'failed'
      && previous.failure_reason === 'auth_failed'
      && previous.auth_rejection_triage_stage !== null
        ? 'regenerate_credential_or_contact_admin'
        : null;
    const failed = failCredentialRotationStmt.run({
      attempt_id: input.attempt_id,
      finished_at: input.finished_at,
      failure_reason: input.reason,
      auth_type: input.auth_type ?? null,
      auth_rejection_triage_stage: triageStage,
      auth_rejection_resolution: resolution,
    });
    if (failed.changes !== 1) {
      throw new Error('credential rotation attempt is no longer pending');
    }
    const attempt = readCredentialRotationAttempt(input.attempt_id);
    if (attempt === null) {
      throw new Error('credential rotation failure was not durable');
    }
    return attempt;
  });
  const acknowledgeCredentialRotationSafeStop = db.transaction((input: {
    attempt_id: string;
    kind: ConnectionKind;
    name: string;
    acknowledged_at: number;
  }): {
    status: 'acknowledged' | 'already_acknowledged';
    attempt: Extract<
      ConnectionCredentialRotationAttemptRow,
      { status: 'failed' }
    > & { safe_stop_acknowledged_at: number };
  } | null => {
    const before = readCredentialRotationAttempt(input.attempt_id);
    if (
      before?.status !== 'failed'
      || before.kind !== input.kind
      || before.name !== input.name
      || before.failure_reason !== 'auth_failed'
      || before.auth_type === undefined
      || before.auth_rejection_resolution
        !== 'regenerate_credential_or_contact_admin'
    ) return null;
    const latest = getLatestCredentialRotationForConnectionStmt.get(
      input.kind,
      input.name,
    ) as CredentialRotationAttemptDbRow | undefined;
    if (latest?.attempt_id !== input.attempt_id) return null;
    if (before.safe_stop_acknowledged_at !== undefined) {
      return {
        status: 'already_acknowledged',
        attempt: before as typeof before & { safe_stop_acknowledged_at: number },
      };
    }
    if (acknowledgeCredentialRotationSafeStopStmt.run(input).changes !== 1) {
      return null;
    }
    const after = readCredentialRotationAttempt(input.attempt_id);
    if (
      after?.status !== 'failed'
      || after.safe_stop_acknowledged_at === undefined
    ) {
      throw new Error('credential safe-stop acknowledgement was not durable');
    }
    return { status: 'acknowledged', attempt: after as typeof after & {
      safe_stop_acknowledged_at: number;
    } };
  });

  return {
    upsert(input) {
      upsertStmt.run(upsertParams(input));
      const row = dbRowToConnectionRow(
        getStmt.get(input.kind, input.name) as ConnectionDbRow,
      );
      for (const handler of onUpsertHandlers) {
        try { handler(row); } catch { /* best-effort */ }
      }
      return row;
    },

    get(kind, name) {
      const row = getStmt.get(kind, name) as ConnectionDbRow | undefined;
      return row ? dbRowToConnectionRow(row) : null;
    },

    list(query = {}) {
      const rows = (
        query.kind
          ? (listByKindStmt.all(query.kind) as ConnectionDbRow[])
          : (listAllStmt.all() as ConnectionDbRow[])
      );
      return rows.map(dbRowToConnectionRow);
    },

    listSince(since) {
      const rows = listSinceStmt.all(since) as ConnectionDbRow[];
      return rows.map(dbRowToConnectionRow);
    },

    delete(kind, name) {
      const removed = deleteWithCriticalHooks(kind, name);
      if (removed) {
        for (const handler of onDeleteHandlers) {
          try { handler(kind, name); } catch { /* best-effort */ }
        }
      }
      return removed;
    },
    setHealth(kind, name, health_json) {
      // Single-column UPDATE; `updated_at` is deliberately NOT bumped — health is
      // an observation ABOUT the row, not a change TO it, and bumping it would
      // push every dispatch into the sync delta scan (`listSince`).
      const res = db
        .prepare(`UPDATE connections SET health_json = ? WHERE kind = ? AND name = ?`)
        .run(health_json, kind, name);
      return res.changes > 0;
    },


    count() {
      return (countStmt.get() as { n: number }).n;
    },

    claimCredentialRotationAttempt(input) {
      // Acquire the write reservation before reading the current owner so two
      // store instances sharing one SQLite file cannot both observe idle and
      // race their inserts. The partial unique index remains defense in depth.
      return claimCredentialRotation.immediate(input);
    },

    getCredentialRotationAttempt(attemptId) {
      return readCredentialRotationAttempt(attemptId);
    },

    getPendingCredentialRotationAttempt(kind, name) {
      return readPendingCredentialRotationAttempt(kind, name);
    },

    getLatestCredentialRotationAttempt(kind, name) {
      const row = getLatestCredentialRotationForConnectionStmt.get(
        kind,
        name,
      ) as CredentialRotationAttemptDbRow | undefined;
      return row === undefined ? null : dbRowToCredentialRotationAttempt(row);
    },

    listCredentialRotationSafeStops(query = {}) {
      const rows = query.kind === undefined
        ? listCredentialRotationSafeStopsStmt.all()
        : listCredentialRotationSafeStopsByKindStmt.all(query.kind);
      return (rows as CredentialRotationAttemptDbRow[]).map((row) => {
        const attempt = dbRowToCredentialRotationAttempt(row);
        if (attempt.status !== 'failed') {
          throw new Error('credential safe-stop query returned a non-failure');
        }
        return attempt;
      });
    },

    listAcknowledgedCredentialRotationSafeStops(query = {}) {
      const rows = query.kind === undefined
        ? listAcknowledgedCredentialRotationSafeStopsStmt.all()
        : listAcknowledgedCredentialRotationSafeStopsByKindStmt.all(
            query.kind,
          );
      return (rows as CredentialRotationAttemptDbRow[]).map((row) => {
        const attempt = dbRowToCredentialRotationAttempt(row);
        if (
          attempt.status !== 'failed'
          || attempt.safe_stop_acknowledged_at === undefined
        ) {
          throw new Error(
            'acknowledged credential safe-stop query returned an invalid row',
          );
        }
        return attempt as typeof attempt & {
          safe_stop_acknowledged_at: number;
        };
      });
    },

    acknowledgeCredentialRotationSafeStop(input) {
      return acknowledgeCredentialRotationSafeStop(input);
    },

    completeCredentialRotationAttempt(input) {
      const row = completeCredentialRotation(input);
      for (const handler of onUpsertHandlers) {
        try { handler(row); } catch { /* best-effort */ }
      }
      return row;
    },

    failCredentialRotationAttempt(input) {
      return failCredentialRotation.immediate(input);
    },

    addOnUpsert(handler) {
      onUpsertHandlers.add(handler);
      return () => {
        onUpsertHandlers.delete(handler);
      };
    },

    addOnDelete(handler) {
      onDeleteHandlers.add(handler);
      return () => {
        onDeleteHandlers.delete(handler);
      };
    },

    addBeforeDelete(handler) {
      beforeDeleteHandlers.add(handler);
      return () => {
        beforeDeleteHandlers.delete(handler);
      };
    },
  };
};
