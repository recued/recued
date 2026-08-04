/** D-145 PA1 — Canonical work entity storage (`task` / `note` /
 *  `commitment` / `project`) + Source registry + note access ledger.
 *
 *  Per § A.1 + § A.1.6 + § A.2.1. Each kind has its own SQLite table
 *  with the per-kind canonical fields plus the uniform Source-row-
 *  identity columns. The Source registry is one shared table. The
 *  note access ledger is server-internal — no cross-cloud sync
 *  (D-097 / D-168), never returned via MCP.
 *
 *  Many-to-many relationships (`blocks_task_ids`, `related_contact_ids`
 *  etc.) ship as JSON-array columns at PA1. Lifting to junction
 *  tables stays open for PA4 if reactive triggers need indexed
 *  reverse lookup; the row-shape contract on `WorkEntity*` stays
 *  identical either way.
 *
 *  Spec: D-145 § A.1 + § A.1.6 + § A.2.1. */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  CONFLICT_POLICIES,
  COMMITMENT_AMOUNT_REGEX,
  COMMITMENT_CURRENCY_REGEX,
  COMMITMENT_DIRECTION_SET,
  COMMITMENT_DERIVATION_SET,
  COMMITMENT_DUE_STATUS_SET,
  COMMITMENT_EVIDENCE_BLOB_MAX_BYTES,
  COMMITMENT_EVIDENCE_KIND_SET,
  COMMITMENT_MAIL_EVIDENCE_SNIPPET_MAX,
  COMMITMENT_MAIL_EVIDENCE_SOURCE_SET,
  COMMITMENT_MESSAGE_EVIDENCE_SNIPPET_MAX,
  COMMITMENT_EXPIRY_POLICY_SET,
  COMMITMENT_LIFECYCLE_STATE_SET,
  COMMITMENT_STATEMENT_MAX,
  NOTE_ACCESS_KIND_SET,
  NOTE_TITLE_MAX,
  PROJECT_HIERARCHY_MAX_DEPTH,
  PROJECT_STATE_SET,
  PROJECT_TITLE_MAX,
  SOURCE_KIND_SET,
  SOURCE_TOP_TIER_KIND_SET,
  isSourceSyncPosture,
  SYNC_STATES,
  SYNC_STATE_SET,
  TASK_PRIORITY_SET,
  TASK_TITLE_MAX,
  TASK_STATE_MAX,
  WORK_ENTITY_KINDS,
  WORK_ENTITY_KIND_SET,
  BOOKING_DEFAULT_LIFECYCLE_STATE,
  BOOKING_LIFECYCLE_STATE_SET,
  BOOKING_TITLE_MAX,
  type Booking,
  type BookingHistorySummary,
  type BookingLifecycleState,
  type Commitment,
  type CommitmentDirection,
  type CommitmentDerivation,
  type CommitmentDueStatus,
  type CommitmentEvidenceEntry,
  type CommitmentExpiryPolicy,
  type CommitmentLifecycleState,
  type ConflictPolicy,
  type MonetaryValue,
  type Note,
  type NoteAccessKind,
  type NoteAccessLedgerEntry,
  type Project,
  type ProjectState,
  type SourceRegistration,
  type SourceKind,
  type SourceSyncPosture,
  type SourceTopTierKind,
  type SyncState,
  type Task,
  type WorkEntityPendingWrite,
  type TaskPriority,
  type WorkEntity,
  type WorkEntityKind,
} from '@recued/contracts';

import { contactAddressSet } from './contact-merge-graph.js';

// ────────────────────────────────────────────────────────────────
// Table names — exported for tests + downstream housekeeping refs.
// ────────────────────────────────────────────────────────────────

export const SOURCE_REGISTRY_TABLE = 'source_registry';
export const TASK_TABLE = 'data_task';
export const NOTE_TABLE = 'data_note';
export const COMMITMENT_TABLE = 'data_commitment';
export const PROJECT_TABLE = 'data_project';
export const BOOKING_TABLE = 'data_booking';
export const NOTE_ACCESS_LEDGER_TABLE = 'note_access_ledger';
export const NOTE_FTS_TABLE = 'data_note_fts';
/** D-145 PA2 — per-kind default-Source memory. Server-global (per
 *  the single-user-warehouse invariant); one row per kind. The
 *  `prefs.<kind>.last_used_source_id` shape in § A.2.2 is the
 *  recipe-time read path; this table is its server-side backing
 *  store. Hard FK with `ON DELETE CASCADE` so unregistering the
 *  pointed-at Source clears the default automatically (the only
 *  load-bearing place a hard FK against `source_registry` is
 *  appropriate — the default is a forward-looking pointer, not
 *  preserved history like the data_<kind>.source_id columns). */
export const WORK_ENTITY_DEFAULT_SOURCE_TABLE = 'work_entity_default_source';

const TABLE_FOR_KIND: Record<WorkEntityKind, string> = {
  task: TASK_TABLE,
  note: NOTE_TABLE,
  commitment: COMMITMENT_TABLE,
  project: PROJECT_TABLE,
  booking: BOOKING_TABLE,
};

// ────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────

export class WorkEntityValidationError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'WorkEntityValidationError';
    this.field = field;
  }
}

export class SourceRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceRegistrationError';
  }
}

// ────────────────────────────────────────────────────────────────
// Schema install — idempotent, safe on every boot.
// ────────────────────────────────────────────────────────────────

// § A.1.6 — `source_id` is intentionally NOT a hard FK to
// `source_registry(id)`. The 'orphaned' sync_state preserves rows
// whose Source row has been unregistered (audit + cascade history),
// so the substrate must allow `data_<kind>.source_id` to reference a
// source_registry id that no longer exists. Write-time validation in
// `resolveSourceIdentity` enforces existence at insert; the schema
// stays soft so unregister-then-orphan is a single atomic transaction.
const SOURCE_ROW_IDENTITY_DDL = `
  source_id              TEXT NOT NULL,
  source_record_id       TEXT,
  connection_id          TEXT,
  source_updated_at      INTEGER,
  last_seen_at           INTEGER NOT NULL,
  deleted_at             INTEGER,
  sync_state             TEXT NOT NULL DEFAULT 'live',
  conflict_policy        TEXT NOT NULL DEFAULT 'source_wins',
  source_record_hash     TEXT,
  source_extension_blob  TEXT,
  source_version_token   TEXT,
  pending_write_blob     TEXT
`;

const sourceRowIdentityIndexes = (kind: WorkEntityKind, table: string): string => `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_${kind}_source_record
    ON ${table} (source_id, source_record_id)
    WHERE source_record_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_${kind}_sync_state
    ON ${table} (sync_state)
    WHERE sync_state != 'live';
  CREATE INDEX IF NOT EXISTS idx_${kind}_last_seen
    ON ${table} (source_id, last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_${kind}_deleted_at
    ON ${table} (deleted_at)
    WHERE deleted_at IS NOT NULL;
`;

/** Register `js_lower` on this CONNECTION.
 *
 *  ⛔ SQLite's built-in `LOWER()` folds ASCII ONLY (no ICU in better-sqlite3):
 *  `LOWER('École')` is `'École'`, while JS `.toLowerCase()` folds the full
 *  Unicode range. Building a search pattern in JS and comparing it against a
 *  SQL-lowered column therefore matches NOTHING for any accented or non-Latin
 *  term — and because the count query runs the same predicate, the empty page
 *  reads as authoritative rather than broken.
 *
 *  Called from BOTH `ensureWorkEntitySchema` and `createWorkEntityStore`
 *  (mirroring `phone_match_forms_json` in `contact-store.ts`, for the same
 *  reason): a function is bound to a connection, not to a schema, so binding it
 *  in only one of the two would make booking search depend on the order a
 *  caller happened to use. Re-registration safely replaces in better-sqlite3,
 *  so calling it twice is a no-op. */
const registerWorkEntitySqlFunctions = (db: Database.Database): void => {
  db.function('js_lower', { deterministic: true }, (value: unknown) =>
    typeof value === 'string' ? value.toLowerCase() : '');
};

export const ensureWorkEntitySchema = (db: Database.Database): void => {
  registerWorkEntitySqlFunctions(db);
  // Foreign-key enforcement matches existing stores' assumption.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SOURCE_REGISTRY_TABLE} (
      id                     TEXT PRIMARY KEY,
      top_tier_kind          TEXT NOT NULL,
      source_kind            TEXT NOT NULL,
      source_label           TEXT NOT NULL,
      write_capable          INTEGER NOT NULL,
      mcp_exposed            INTEGER NOT NULL,
      schema_extension_blob  TEXT,
      registered_at          INTEGER NOT NULL,
      config_blob            TEXT,
      enabled                INTEGER NOT NULL DEFAULT 1,
      sync_posture           TEXT NOT NULL DEFAULT 'records'
    );
    CREATE INDEX IF NOT EXISTS idx_source_registry_kind
      ON ${SOURCE_REGISTRY_TABLE} (top_tier_kind);
  `);

  // D-145 PA11 — Settings → Work Entities user toggle. `enabled`
  // joined source_registry at PA11; pre-launch zero-migration rule
  // (`feedback_pre_launch_no_migration.md`) means an ALTER on existing
  // dev databases brings the column into existence without a
  // migration script. SQLite raises a `duplicate column name` error
  // when the column already exists; swallow that exact error so boot
  // stays idempotent. Any other error propagates.
  try {
    db.exec(
      `ALTER TABLE ${SOURCE_REGISTRY_TABLE} ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name: enabled/i.test(msg)) throw err;
  }

  // D-192 P-1 — `sync_posture` joins source_registry at P-1 (the file
  // SOURCE family prerequisite). Same pre-launch zero-migration ADD
  // COLUMN idiom as `enabled` above: existing dev rows default to
  // `'records'` (every Source built before P-1 is records-posture).
  try {
    db.exec(
      `ALTER TABLE ${SOURCE_REGISTRY_TABLE} ADD COLUMN sync_posture TEXT NOT NULL DEFAULT 'records'`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name: sync_posture/i.test(msg)) throw err;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TASK_TABLE} (
      id                       TEXT PRIMARY KEY,
      title                    TEXT NOT NULL,
      body                     TEXT,
      done                     INTEGER NOT NULL DEFAULT 0,
      due_at                   INTEGER,
      priority                 TEXT,
      created_at               INTEGER NOT NULL,
      updated_at               INTEGER NOT NULL,
      completed_at             INTEGER,
      assigned_contact_id      TEXT,
      parent_calendar_event_id TEXT,
      linked_mail_thread_id    TEXT,
      parent_project_id        TEXT,
      blocks_task_ids          TEXT NOT NULL DEFAULT '[]',
      state                    TEXT,
      progress                 INTEGER,
      ${SOURCE_ROW_IDENTITY_DDL}
    );
    CREATE INDEX IF NOT EXISTS idx_task_done_due
      ON ${TASK_TABLE} (done, due_at);
    CREATE INDEX IF NOT EXISTS idx_task_assigned_done
      ON ${TASK_TABLE} (assigned_contact_id, done);
    CREATE INDEX IF NOT EXISTS idx_task_project_done
      ON ${TASK_TABLE} (parent_project_id, done);
    ${sourceRowIdentityIndexes('task', TASK_TABLE)}
  `);

  // D-179 fork (a) — `state` + `progress` on a table that pre-dates
  // them. Same swallow-duplicate-column idiom as the PA11 ALTER above.
  for (const ddl of [
    `ALTER TABLE ${TASK_TABLE} ADD COLUMN state TEXT`,
    `ALTER TABLE ${TASK_TABLE} ADD COLUMN progress INTEGER`,
  ]) {
    try {
      db.exec(ddl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name: (state|progress)/i.test(msg)) throw err;
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${NOTE_TABLE} (
      id                          TEXT PRIMARY KEY,
      title                       TEXT,
      body                        TEXT NOT NULL,
      created_at                  INTEGER NOT NULL,
      updated_at                  INTEGER NOT NULL,
      last_user_action_at         INTEGER NOT NULL,
      related_contact_ids         TEXT NOT NULL DEFAULT '[]',
      related_calendar_event_ids  TEXT NOT NULL DEFAULT '[]',
      related_mail_thread_ids     TEXT NOT NULL DEFAULT '[]',
      related_project_ids         TEXT NOT NULL DEFAULT '[]',
      ${SOURCE_ROW_IDENTITY_DDL}
    );
    CREATE INDEX IF NOT EXISTS idx_note_last_user_action
      ON ${NOTE_TABLE} (last_user_action_at DESC);
    ${sourceRowIdentityIndexes('note', NOTE_TABLE)}
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${COMMITMENT_TABLE} (
      id                          TEXT PRIMARY KEY,
      direction                   TEXT NOT NULL,
      statement                   TEXT NOT NULL,
      promised_at                 INTEGER NOT NULL,
      promised_for_at             INTEGER,
      lifecycle_state             TEXT NOT NULL DEFAULT 'pending',
      due_status                  TEXT NOT NULL DEFAULT 'no_deadline',
      expiry_policy               TEXT NOT NULL DEFAULT 'escalate_overdue',
      state_changed_at            INTEGER NOT NULL,
      lifecycle_changed_at        INTEGER NOT NULL,
      due_status_changed_at       INTEGER NOT NULL,
      derivation                  TEXT NOT NULL,
      derivation_confidence       REAL,
      monetary_amount             TEXT,
      monetary_currency           TEXT,
      counterparty_contact_id     TEXT,
      derived_from_mail_thread_id TEXT,
      derived_from_meeting_id     TEXT,
      blocks_task_ids             TEXT NOT NULL DEFAULT '[]',
      blocks_project_ids          TEXT NOT NULL DEFAULT '[]',
      evidence_blob               TEXT,
      created_at                  INTEGER NOT NULL,
      updated_at                  INTEGER NOT NULL,
      ${SOURCE_ROW_IDENTITY_DDL},
      CHECK (
        (monetary_amount IS NULL AND monetary_currency IS NULL)
        OR (monetary_amount IS NOT NULL AND monetary_currency IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_commitment_lifecycle_due
      ON ${COMMITMENT_TABLE} (lifecycle_state, promised_for_at);
    CREATE INDEX IF NOT EXISTS idx_commitment_due_status
      ON ${COMMITMENT_TABLE} (due_status, promised_for_at);
    CREATE INDEX IF NOT EXISTS idx_commitment_counterparty_lifecycle
      ON ${COMMITMENT_TABLE} (counterparty_contact_id, lifecycle_state);
    CREATE INDEX IF NOT EXISTS idx_commitment_direction_lifecycle
      ON ${COMMITMENT_TABLE} (direction, lifecycle_state);
    CREATE INDEX IF NOT EXISTS idx_commitment_counterparty_currency
      ON ${COMMITMENT_TABLE} (counterparty_contact_id, lifecycle_state, monetary_currency);
    ${sourceRowIdentityIndexes('commitment', COMMITMENT_TABLE)}
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PROJECT_TABLE} (
      id                    TEXT PRIMARY KEY,
      title                 TEXT NOT NULL,
      description           TEXT,
      state                 TEXT NOT NULL DEFAULT 'active',
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      target_completion_at  INTEGER,
      last_activity_at      INTEGER NOT NULL,
      related_contact_ids   TEXT NOT NULL DEFAULT '[]',
      parent_project_id     TEXT,
      ${SOURCE_ROW_IDENTITY_DDL}
    );
    CREATE INDEX IF NOT EXISTS idx_project_state_activity
      ON ${PROJECT_TABLE} (state, last_activity_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_target_state
      ON ${PROJECT_TABLE} (target_completion_at, state);
    CREATE INDEX IF NOT EXISTS idx_project_parent
      ON ${PROJECT_TABLE} (parent_project_id);
    ${sourceRowIdentityIndexes('project', PROJECT_TABLE)}
  `);

  // D-210 — `booking`, the mutable business entity for a reservation.
  //
  // 🔑 THE BOOKING OWNS ITS OWN TIME (D-210 A.2, slice 3). This reverses
  // the original "no time column" ruling, and on a CHANGED PREMISE, not a
  // changed mind: that ruling rested on the calendar event owning the
  // slot, and A.2 makes booking and calendar DISJOINT — a booking is
  // never in the calendar. A centre cannot depend on an absent leaf for
  // a core attribute, so the slot is the booking's own fact.
  //
  // 🔑 TWO columns, not three. `duration_minutes` is NOT stored: it is
  // `slot_end_at - slot_start_at`, and storing it would recreate exactly
  // the defect the original ruling correctly feared — one fact held
  // twice, and therefore able to drift. Derive it at the read edge.
  //
  // Both-or-neither via CHECK, mirroring the monetary pair below: a
  // half-populated slot is not a "partly known" time, it is a corrupt
  // one. Nullable as a PAIR because a booking's life can begin before
  // its time is agreed (an owner-authored enquiry) and a phone booking
  // is minted by hand.
  //
  // `lifecycle_state` defaults to 'confirmed', NOT the first member of
  // BOOKING_LIFECYCLE_STATES — a Recued-minted booking is created at
  // APPROVE, so the approval is the confirmation. `pending` exists for
  // owner-authored flows and nothing in Recued writes it.
  //
  // ⛔ NO CALENDAR COLUMN, and adding one back is not a small convenience.
  // `calendar_event_source_id` lived here until slice 3c; it is gone with
  // the event-creation seam and the `scheduled-from` edge. A pointer is
  // what let a reservation exist as two artifacts that drift — the whole
  // defect A.2 removed. `reception_record_id` below is provenance (which
  // ASK this booking came from), not a second home for its time.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${BOOKING_TABLE} (
      id                        TEXT PRIMARY KEY,
      title                     TEXT NOT NULL,
      lifecycle_state           TEXT NOT NULL DEFAULT 'confirmed',
      state_changed_at          INTEGER NOT NULL,
      created_at                INTEGER NOT NULL,
      updated_at                INTEGER NOT NULL,
      slot_start_at             INTEGER,
      slot_end_at               INTEGER,
      monetary_amount           TEXT,
      monetary_currency         TEXT,
      counterparty_contact_id   TEXT,
      reception_record_id       TEXT,
      ${SOURCE_ROW_IDENTITY_DDL},
      CHECK (
        (monetary_amount IS NULL AND monetary_currency IS NULL)
        OR (monetary_amount IS NOT NULL AND monetary_currency IS NOT NULL)
      ),
      CHECK (
        (slot_start_at IS NULL AND slot_end_at IS NULL)
        OR (slot_start_at IS NOT NULL AND slot_end_at IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_booking_lifecycle_created
      ON ${BOOKING_TABLE} (lifecycle_state, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_booking_counterparty_lifecycle
      ON ${BOOKING_TABLE} (counterparty_contact_id, lifecycle_state);
    CREATE INDEX IF NOT EXISTS idx_booking_counterparty_history
      ON ${BOOKING_TABLE} (counterparty_contact_id, lifecycle_state, state_changed_at DESC);
    -- UNIQUE, not a plain index: ONE booking per reception record is the
    -- rule, and booking-create mints a fresh uuid per call, so nothing else
    -- stops a retried / replayed approve from minting a SECOND booking for the
    -- same request -- duplicating the customer and the money. The reception
    -- mint path (D-210 slice 3) reads this row back as its idempotency anchor,
    -- exactly as the calendar seam uses resolved_calendar_event_id (I-4).
    -- (No backticks in here: this comment lives INSIDE a template literal.)
    CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_reception_record
      ON ${BOOKING_TABLE} (reception_record_id)
      WHERE reception_record_id IS NOT NULL;
    ${sourceRowIdentityIndexes('booking', BOOKING_TABLE)}
  `);

  // D-192 P4 — `source_version_token` (conditional-write precondition,
  // vendor version value VERBATIM) + `pending_write_blob` (dirty-write
  // state JSON) on every kind table that pre-dates them. Same
  // swallow-duplicate-column idiom as the PA11 / D-179 ALTERs above.
  //
  // ⚠ `data_booking` is deliberately ABSENT — it ships with both
  // columns in its CREATE TABLE above, so an ALTER would be a no-op
  // that only widens the swallow window. Hand-listed rather than
  // derived from WORK_ENTITY_KINDS for exactly that reason.
  for (const table of [TASK_TABLE, NOTE_TABLE, COMMITMENT_TABLE, PROJECT_TABLE]) {
    for (const column of ['source_version_token TEXT', 'pending_write_blob TEXT']) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name: (source_version_token|pending_write_blob)/i.test(msg)) throw err;
      }
    }
  }

  // D-192 F1 — `evidence_blob` (immutable capture snapshots for
  // `evidence_captured` commitments) on a `data_commitment` table that
  // pre-dates it. Same swallow-duplicate-column idiom.
  try {
    db.exec(`ALTER TABLE ${COMMITMENT_TABLE} ADD COLUMN evidence_blob TEXT`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name: evidence_blob/i.test(msg)) throw err;
  }

  // D-210 A.2 slice 3 — the booking's own slot, on a `data_booking` that
  // pre-dates it. REQUIRED, not belt-and-braces: `CREATE TABLE IF NOT
  // EXISTS` above skips an existing table outright, so without this a dev
  // server keeps the old shape and every prepared statement naming these
  // columns throws at PREPARE time — the failure the D-210 slice-3 rename
  // hit in `reception-store.ts`.
  //
  // ⚠ No CHECK comes with an ALTER (SQLite cannot add one to a live
  // table). A pre-existing row cannot violate both-or-neither — it has
  // NULL for both — and every write goes through `writeBooking`, which
  // resolves the pair together. Fresh DBs get the CHECK from the CREATE.
  for (const column of ['slot_start_at INTEGER', 'slot_end_at INTEGER']) {
    try {
      db.exec(`ALTER TABLE ${BOOKING_TABLE} ADD COLUMN ${column}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name: (slot_start_at|slot_end_at)/i.test(msg)) throw err;
    }
  }

  // ⚠ AFTER the ALTER, deliberately — NOT in the CREATE TABLE block with
  // booking's other indices. On a pre-existing table `CREATE TABLE IF NOT
  // EXISTS` is a no-op, so the column does not exist until the loop above
  // runs and an index naming it would throw `no such column`.
  //
  // "What is booked, and when" is the primary business query now that the
  // booking owns its slot and the calendar is not there to answer it.
  // Partial: an un-timed booking is never a row this index is asked about.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_booking_slot_start
      ON ${BOOKING_TABLE} (slot_start_at)
      WHERE slot_start_at IS NOT NULL;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${WORK_ENTITY_DEFAULT_SOURCE_TABLE} (
      kind          TEXT PRIMARY KEY,
      source_id     TEXT NOT NULL,
      updated_at    INTEGER NOT NULL,
      FOREIGN KEY (source_id) REFERENCES ${SOURCE_REGISTRY_TABLE}(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${NOTE_ACCESS_LEDGER_TABLE} (
      id              TEXT PRIMARY KEY,
      note_id         TEXT NOT NULL REFERENCES ${NOTE_TABLE}(id),
      accessed_at     INTEGER NOT NULL,
      access_kind     TEXT NOT NULL,
      access_actor    TEXT,
      metadata_blob   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_nal_note_time
      ON ${NOTE_ACCESS_LEDGER_TABLE} (note_id, accessed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_nal_kind_time
      ON ${NOTE_ACCESS_LEDGER_TABLE} (access_kind, accessed_at DESC);
  `);

  // Full-text search index over note body per § A.1.2. Contentless
  // FTS5 table mirrored from `data_note(body)`; triggers keep both
  // sides in sync. A single rebuild on schema-install handles dev
  // databases that pre-date the FTS pass — `INSERT INTO ... (rowid,
  // body) SELECT ...` is a no-op when the FTS table is already
  // populated for those rowids.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${NOTE_FTS_TABLE}
      USING fts5(body, content='${NOTE_TABLE}', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS trg_${NOTE_TABLE}_ai_fts
      AFTER INSERT ON ${NOTE_TABLE} BEGIN
        INSERT INTO ${NOTE_FTS_TABLE}(rowid, body) VALUES (new.rowid, new.body);
      END;
    CREATE TRIGGER IF NOT EXISTS trg_${NOTE_TABLE}_au_fts
      AFTER UPDATE OF body ON ${NOTE_TABLE} BEGIN
        INSERT INTO ${NOTE_FTS_TABLE}(${NOTE_FTS_TABLE}, rowid, body) VALUES('delete', old.rowid, old.body);
        INSERT INTO ${NOTE_FTS_TABLE}(rowid, body) VALUES (new.rowid, new.body);
      END;
    CREATE TRIGGER IF NOT EXISTS trg_${NOTE_TABLE}_ad_fts
      AFTER DELETE ON ${NOTE_TABLE} BEGIN
        INSERT INTO ${NOTE_FTS_TABLE}(${NOTE_FTS_TABLE}, rowid, body) VALUES('delete', old.rowid, old.body);
      END;
  `);
};

// ────────────────────────────────────────────────────────────────
// JSON helpers
// ────────────────────────────────────────────────────────────────

const stringifyArray = (arr?: readonly string[]): string =>
  arr && arr.length > 0 ? JSON.stringify(arr) : '[]';

const parseStringArray = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]).filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const stringifyJsonObject = (
  obj?: Record<string, unknown>,
): string | null => (obj === undefined ? null : JSON.stringify(obj));

const parseJsonObject = (
  raw: string | null | undefined,
): Record<string, unknown> | undefined => {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const boolToInt = (b: boolean | undefined, dflt: boolean): number =>
  (b === undefined ? dflt : b) ? 1 : 0;

const intToBool = (n: number | null): boolean => n === 1;

// ────────────────────────────────────────────────────────────────
// Source identity helpers — write-input shape shared across kinds.
// ────────────────────────────────────────────────────────────────

export interface WorkEntitySourceIdentityInput {
  source_id: string;
  source_record_id?: string;
  connection_id?: string;
  source_updated_at?: number;
  last_seen_at?: number;
  sync_state?: SyncState;
  conflict_policy?: ConflictPolicy;
  source_record_hash?: string;
  source_extension_blob?: Record<string, unknown>;
  /** D-192 P4 — the vendor version value VERBATIM (etag / revision /
   *  content-hash / raw timestamp string), the conditional-write
   *  precondition token. `pending_write` is deliberately NOT part of
   *  this input: the dirty-write state has its own
   *  `stagePendingWrite` / `clearPendingWrite` channel so a full-row
   *  upsert (sync, dispatcher patch) can never silently clear a
   *  staged local edit. */
  source_version_token?: string;
}

interface ResolvedSourceIdentity {
  source_id: string;
  source_record_id: string | null;
  connection_id: string | null;
  source_updated_at: number | null;
  last_seen_at: number;
  deleted_at: number | null;
  sync_state: SyncState;
  conflict_policy: ConflictPolicy;
  source_record_hash: string | null;
  source_extension_blob: string | null;
  source_version_token: string | null;
}

const resolveSourceIdentity = (
  input: WorkEntitySourceIdentityInput,
  now: number,
  store: WorkEntityStoreInternal,
  expectedKind: WorkEntityKind,
): ResolvedSourceIdentity => {
  if (typeof input.source_id !== 'string' || input.source_id.length === 0) {
    throw new WorkEntityValidationError('source_id is required', 'source_id');
  }
  const registeredKind = store.sourceTopTierKind(input.source_id);
  if (registeredKind === null) {
    throw new WorkEntityValidationError(
      `source_id '${input.source_id}' is not registered in source_registry`,
      'source_id',
    );
  }
  // § A.2 per-kind scoping — a Source is bound to one top_tier_kind.
  // Writing a `task` row against a `note` Source crosses kinds and
  // breaks the polymorphic resolver's invariant; reject at write time.
  if (registeredKind !== expectedKind) {
    throw new WorkEntityValidationError(
      `source_id '${input.source_id}' is registered for top_tier_kind '${registeredKind}', not '${expectedKind}'`,
      'source_id',
    );
  }
  const sync_state = input.sync_state ?? 'live';
  if (!SYNC_STATE_SET.has(sync_state)) {
    throw new WorkEntityValidationError(`unknown sync_state '${sync_state}'`, 'sync_state');
  }
  const conflict_policy = input.conflict_policy ?? 'source_wins';
  if (!CONFLICT_POLICIES.includes(conflict_policy)) {
    throw new WorkEntityValidationError(
      `unknown conflict_policy '${conflict_policy}'`,
      'conflict_policy',
    );
  }
  return {
    source_id: input.source_id,
    source_record_id: input.source_record_id ?? null,
    connection_id: input.connection_id ?? null,
    source_updated_at: input.source_updated_at ?? null,
    last_seen_at: input.last_seen_at ?? now,
    // A full-row write asserts a LIVE row: the upsert's ON CONFLICT
    // clauses carry `deleted_at = excluded.deleted_at`, so writing a
    // tombstoned row RESURRECTS it (D-192 P3b — a remote record that
    // reappears un-archives under its original local id; matches the
    // `sync_state` reset in the same clause).
    deleted_at: null,
    sync_state,
    conflict_policy,
    source_record_hash: input.source_record_hash ?? null,
    source_extension_blob: stringifyJsonObject(input.source_extension_blob),
    source_version_token: input.source_version_token ?? null,
  };
};

// ────────────────────────────────────────────────────────────────
// Per-kind input + row shapes
// ────────────────────────────────────────────────────────────────

export interface TaskWriteInput extends WorkEntitySourceIdentityInput {
  id?: string;
  title: string;
  body?: string;
  done?: boolean;
  due_at?: number;
  priority?: TaskPriority;
  completed_at?: number;
  assigned_contact_id?: string;
  parent_calendar_event_id?: string;
  linked_mail_thread_id?: string;
  parent_project_id?: string;
  blocks_task_ids?: readonly string[];
  /** D-179 fork (a) — free-form domain state + 0–100 progress. */
  state?: string;
  progress?: number;
  created_at?: number;
  updated_at?: number;
}

export interface NoteWriteInput extends WorkEntitySourceIdentityInput {
  id?: string;
  title?: string;
  body: string;
  last_user_action_at?: number;
  related_contact_ids?: readonly string[];
  related_calendar_event_ids?: readonly string[];
  related_mail_thread_ids?: readonly string[];
  related_project_ids?: readonly string[];
  created_at?: number;
  updated_at?: number;
}

export interface CommitmentWriteInput extends WorkEntitySourceIdentityInput {
  id?: string;
  direction: CommitmentDirection;
  statement: string;
  promised_at?: number;
  promised_for_at?: number;
  lifecycle_state?: CommitmentLifecycleState;
  due_status?: CommitmentDueStatus;
  expiry_policy?: CommitmentExpiryPolicy;
  derivation: CommitmentDerivation;
  derivation_confidence?: number;
  monetary_value?: MonetaryValue;
  counterparty_contact_id?: string;
  derived_from_mail_thread_id?: string;
  derived_from_meeting_id?: string;
  blocks_task_ids?: readonly string[];
  blocks_project_ids?: readonly string[];
  /** D-192 F1 — immutable evidence snapshots (capture-owned lane;
   *  never sync-written). Validated: non-empty array of entries with
   *  a registered `kind`, serialized ≤
   *  `COMMITMENT_EVIDENCE_BLOB_MAX_BYTES` (over-cap REFUSES — clipped
   *  evidence is not the as-was value). */
  evidence_blob?: readonly CommitmentEvidenceEntry[];
  created_at?: number;
  updated_at?: number;
  state_changed_at?: number;
  lifecycle_changed_at?: number;
  due_status_changed_at?: number;
}

/** D-210 — the booking business row. The booking owns its own WHEN
 *  (A.2): booking and calendar are disjoint, so the slot is this row's
 *  fact and not a pointer to somebody else's. */
export interface BookingWriteInput extends WorkEntitySourceIdentityInput {
  id?: string;
  title: string;
  /** Defaults to `BOOKING_DEFAULT_LIFECYCLE_STATE` ('confirmed'), NOT
   *  the first member of the enum. */
  lifecycle_state?: BookingLifecycleState;
  /** BOTH-OR-NEITHER. Supplying one without the other is rejected rather
   *  than half-written — see `resolveBookingSlot`. Duration is derived
   *  (`slot_end_at - slot_start_at`), never stored. */
  slot_start_at?: number;
  slot_end_at?: number;
  monetary_value?: MonetaryValue;
  counterparty_contact_id?: string;
  reception_record_id?: string;
  created_at?: number;
  updated_at?: number;
  state_changed_at?: number;
}

export interface ProjectWriteInput extends WorkEntitySourceIdentityInput {
  id?: string;
  title: string;
  description?: string;
  state?: ProjectState;
  target_completion_at?: number;
  last_activity_at?: number;
  related_contact_ids?: readonly string[];
  parent_project_id?: string;
  created_at?: number;
  updated_at?: number;
}

export interface WorkEntityListQuery {
  /** Filter on `sync_state`. Default: rows in `live` or
   *  `stale_unreachable` only — tombstoned + orphaned excluded. */
  sync_states?: readonly SyncState[];
  source_id?: string;
  /** When true, returns rows even when `deleted_at IS NOT NULL`.
   *  Default false — § A.1.6 "All Sources" filter. */
  include_deleted?: boolean;
  /** D-145 PA11 — when true, polymorphic reads include rows whose
   *  Source is disabled in `source_registry`. Default false: a
   *  user-disabled Source's rows do NOT appear in `data.<kind>.*`
   *  reads. Bypassed automatically when `source_id` is set (explicit
   *  scope wins; admin tools can read a disabled Source's rows by
   *  scoping to it directly). */
  include_disabled?: boolean;
  /** Task/project-only exact parent scope. Used by recipe-callable native
   *  reads and the federated-project Source so a project board never has to
   *  materialize every private task and filter after the fact. */
  parent_project_id?: string;
  limit?: number;
  offset?: number;
  /** Booking-only search. Applied by SQL before pagination. */
  search?: string;
  /** Booking-only business lifecycle filter. */
  booking_lifecycle_states?: readonly BookingLifecycleState[];
}

export interface WorkEntityRelationshipCounts {
  active_count: number;
  historical_count: number;
  observed_count: number;
}

export interface WorkEntityContactRelationshipSummary {
  tasks: WorkEntityRelationshipCounts;
  bookings: WorkEntityRelationshipCounts;
  projects: WorkEntityRelationshipCounts;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

const normalizeListQuery = (q?: WorkEntityListQuery): Required<WorkEntityListQuery> => {
  const sync_states =
    q?.sync_states && q.sync_states.length > 0
      ? q.sync_states
      : (['live', 'stale_unreachable'] as const);
  for (const s of sync_states) {
    if (!SYNC_STATE_SET.has(s)) {
      throw new WorkEntityValidationError(`unknown sync_state '${s}'`, 'sync_states');
    }
  }
  const limit = Math.min(Math.max(q?.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const offset = Math.max(q?.offset ?? 0, 0);
  if (q?.search !== undefined && typeof q.search !== 'string') {
    throw new WorkEntityValidationError('search must be a string', 'search');
  }
  const search = q?.search?.trim() ?? '';
  if (search.length > 200) {
    throw new WorkEntityValidationError('search is limited to 200 characters', 'search');
  }
  const booking_lifecycle_states = [
    ...new Set(q?.booking_lifecycle_states ?? []),
  ];
  for (const state of booking_lifecycle_states) {
    if (!BOOKING_LIFECYCLE_STATE_SET.has(state)) {
      throw new WorkEntityValidationError(
        `unknown booking lifecycle_state '${String(state)}'`,
        'booking_lifecycle_states',
      );
    }
  }
  return {
    sync_states,
    source_id: q?.source_id ?? '',
    include_deleted: q?.include_deleted ?? false,
    include_disabled: q?.include_disabled ?? false,
    parent_project_id: q?.parent_project_id ?? '',
    limit,
    offset,
    search,
    booking_lifecycle_states,
  };
};

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

const buildListWhere = (
  q: Required<WorkEntityListQuery>,
  bookingFilters = false,
  parentProjectFilter = false,
): { sql: string; params: unknown[] } => {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const placeholders = q.sync_states.map(() => '?').join(', ');
  clauses.push(`sync_state IN (${placeholders})`);
  params.push(...q.sync_states);
  if (q.source_id) {
    clauses.push('source_id = ?');
    params.push(q.source_id);
  }
  if (!q.include_disabled) {
    // D-145 PA11 — reads exclude rows whose Source is EXPLICITLY
    // disabled. NOT IN against the disabled-rows subquery so the
    // predicate doesn't accidentally drop orphan rows (Source row
    // deleted via `unregisterSource`; row's source_id no longer in
    // source_registry at all). Orphan rows are filtered separately
    // via the default `sync_state` filter (`'live' |
    // 'stale_unreachable'`); the disabled filter only targets live +
    // still-registered Sources whose user toggle was flipped off.
    //
    // D-145 PA11 Codex P2 fold (finding 3) — apply the disabled
    // filter even when an explicit `source_id` is supplied. Recipe-
    // side `data.<kind>.<source_id>.*` paths that scope to a Source
    // the user later disabled would otherwise silently leak rows
    // back into reads. Admin / debug surfaces opt out via
    // `include_disabled: true`.
    clauses.push(
      `source_id NOT IN (SELECT id FROM ${SOURCE_REGISTRY_TABLE} WHERE enabled = 0)`,
    );
  }
  if (!q.include_deleted) {
    clauses.push('deleted_at IS NULL');
  }
  if (q.parent_project_id.length > 0) {
    if (!parentProjectFilter) {
      throw new WorkEntityValidationError(
        'parent_project_id is a task/project-only filter',
        'parent_project_id',
      );
    }
    clauses.push('parent_project_id = ?');
    params.push(q.parent_project_id);
  }
  if (bookingFilters) {
    if (q.search.length > 0) {
      // `js_lower` (not SQL `LOWER`) on BOTH sides — see `ensureWorkEntitySchema`.
      // The JS-built pattern folds the full Unicode range, so the column must
      // fold the same way or `École` never matches the title it is stored under.
      const pattern = `%${escapeLike(q.search.toLowerCase())}%`;
      clauses.push(
        `(js_lower(title) LIKE ? ESCAPE '\\' OR js_lower(id) LIKE ? ESCAPE '\\' `
          + `OR js_lower(COALESCE(counterparty_contact_id, '')) LIKE ? ESCAPE '\\')`,
      );
      params.push(pattern, pattern, pattern);
    }
    if (q.booking_lifecycle_states.length > 0) {
      clauses.push(
        `lifecycle_state IN (${q.booking_lifecycle_states.map(() => '?').join(', ')})`,
      );
      params.push(...q.booking_lifecycle_states);
    }
  } else if (q.search.length > 0 || q.booking_lifecycle_states.length > 0) {
    throw new WorkEntityValidationError(
      'search and booking_lifecycle_states are booking-only filters',
      q.search.length > 0 ? 'search' : 'booking_lifecycle_states',
    );
  }
  return { sql: `WHERE ${clauses.join(' AND ')}`, params };
};

// ────────────────────────────────────────────────────────────────
// Row shapes (raw SQLite -> typed)
// ────────────────────────────────────────────────────────────────

interface SourceRowIdentityRow {
  source_id: string;
  source_record_id: string | null;
  connection_id: string | null;
  source_updated_at: number | null;
  last_seen_at: number;
  deleted_at: number | null;
  sync_state: SyncState;
  conflict_policy: ConflictPolicy;
  source_record_hash: string | null;
  source_extension_blob: string | null;
  source_version_token: string | null;
  pending_write_blob: string | null;
}

const projectSourceRowIdentity = (
  row: SourceRowIdentityRow,
): {
  source_id: string;
  source_record_id?: string;
  connection_id?: string;
  source_updated_at?: number;
  last_seen_at: number;
  deleted_at?: number;
  sync_state: SyncState;
  conflict_policy: ConflictPolicy;
  source_record_hash?: string;
  source_extension_blob?: Record<string, unknown>;
  source_version_token?: string;
  pending_write?: WorkEntityPendingWrite;
} => {
  const out: ReturnType<typeof projectSourceRowIdentity> = {
    source_id: row.source_id,
    last_seen_at: row.last_seen_at,
    sync_state: row.sync_state,
    conflict_policy: row.conflict_policy,
  };
  if (row.source_record_id !== null) out.source_record_id = row.source_record_id;
  if (row.connection_id !== null) out.connection_id = row.connection_id;
  if (row.source_updated_at !== null) out.source_updated_at = row.source_updated_at;
  if (row.deleted_at !== null) out.deleted_at = row.deleted_at;
  if (row.source_record_hash !== null) out.source_record_hash = row.source_record_hash;
  const ext = parseJsonObject(row.source_extension_blob);
  if (ext) out.source_extension_blob = ext;
  if (row.source_version_token !== null) out.source_version_token = row.source_version_token;
  const pw = parseJsonObject(row.pending_write_blob);
  if (pw) out.pending_write = pw as unknown as WorkEntityPendingWrite;
  return out;
};

interface TaskRow extends SourceRowIdentityRow {
  id: string;
  title: string;
  body: string | null;
  done: number;
  due_at: number | null;
  priority: TaskPriority | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  assigned_contact_id: string | null;
  parent_calendar_event_id: string | null;
  linked_mail_thread_id: string | null;
  parent_project_id: string | null;
  blocks_task_ids: string;
  state: string | null;
  progress: number | null;
}

const rowToTask = (row: TaskRow): Task => {
  const t: Task = {
    id: row.id,
    title: row.title,
    done: intToBool(row.done),
    created_at: row.created_at,
    updated_at: row.updated_at,
    blocks_task_ids: parseStringArray(row.blocks_task_ids),
    ...projectSourceRowIdentity(row),
  };
  if (row.body !== null) t.body = row.body;
  if (row.due_at !== null) t.due_at = row.due_at;
  if (row.priority !== null) t.priority = row.priority;
  if (row.completed_at !== null) t.completed_at = row.completed_at;
  if (row.assigned_contact_id !== null) t.assigned_contact_id = row.assigned_contact_id;
  if (row.parent_calendar_event_id !== null)
    t.parent_calendar_event_id = row.parent_calendar_event_id;
  if (row.linked_mail_thread_id !== null) t.linked_mail_thread_id = row.linked_mail_thread_id;
  if (row.parent_project_id !== null) t.parent_project_id = row.parent_project_id;
  if (row.state !== null) t.state = row.state;
  if (row.progress !== null) t.progress = row.progress;
  return t;
};

interface NoteRow extends SourceRowIdentityRow {
  id: string;
  title: string | null;
  body: string;
  created_at: number;
  updated_at: number;
  last_user_action_at: number;
  related_contact_ids: string;
  related_calendar_event_ids: string;
  related_mail_thread_ids: string;
  related_project_ids: string;
}

const rowToNote = (row: NoteRow): Note => {
  const n: Note = {
    id: row.id,
    body: row.body,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_user_action_at: row.last_user_action_at,
    related_contact_ids: parseStringArray(row.related_contact_ids),
    related_calendar_event_ids: parseStringArray(row.related_calendar_event_ids),
    related_mail_thread_ids: parseStringArray(row.related_mail_thread_ids),
    related_project_ids: parseStringArray(row.related_project_ids),
    ...projectSourceRowIdentity(row),
  };
  if (row.title !== null) n.title = row.title;
  return n;
};

interface CommitmentRow extends SourceRowIdentityRow {
  id: string;
  direction: CommitmentDirection;
  statement: string;
  promised_at: number;
  promised_for_at: number | null;
  lifecycle_state: CommitmentLifecycleState;
  due_status: CommitmentDueStatus;
  expiry_policy: CommitmentExpiryPolicy;
  state_changed_at: number;
  lifecycle_changed_at: number;
  due_status_changed_at: number;
  derivation: CommitmentDerivation;
  derivation_confidence: number | null;
  monetary_amount: string | null;
  monetary_currency: string | null;
  counterparty_contact_id: string | null;
  derived_from_mail_thread_id: string | null;
  derived_from_meeting_id: string | null;
  blocks_task_ids: string;
  blocks_project_ids: string;
  evidence_blob: string | null;
  created_at: number;
  updated_at: number;
}

const rowToCommitment = (row: CommitmentRow): Commitment => {
  const c: Commitment = {
    id: row.id,
    direction: row.direction,
    statement: row.statement,
    promised_at: row.promised_at,
    lifecycle_state: row.lifecycle_state,
    due_status: row.due_status,
    expiry_policy: row.expiry_policy,
    created_at: row.created_at,
    updated_at: row.updated_at,
    state_changed_at: row.state_changed_at,
    lifecycle_changed_at: row.lifecycle_changed_at,
    due_status_changed_at: row.due_status_changed_at,
    derivation: row.derivation,
    blocks_task_ids: parseStringArray(row.blocks_task_ids),
    blocks_project_ids: parseStringArray(row.blocks_project_ids),
    ...projectSourceRowIdentity(row),
  };
  if (row.promised_for_at !== null) c.promised_for_at = row.promised_for_at;
  if (row.derivation_confidence !== null) c.derivation_confidence = row.derivation_confidence;
  if (row.monetary_amount !== null && row.monetary_currency !== null) {
    c.monetary_value = { amount: row.monetary_amount, currency: row.monetary_currency };
  }
  if (row.counterparty_contact_id !== null) c.counterparty_contact_id = row.counterparty_contact_id;
  if (row.derived_from_mail_thread_id !== null)
    c.derived_from_mail_thread_id = row.derived_from_mail_thread_id;
  if (row.derived_from_meeting_id !== null)
    c.derived_from_meeting_id = row.derived_from_meeting_id;
  if (row.evidence_blob !== null) {
    c.evidence_blob = JSON.parse(row.evidence_blob) as CommitmentEvidenceEntry[];
  }
  return c;
};

interface ProjectRow extends SourceRowIdentityRow {
  id: string;
  title: string;
  description: string | null;
  state: ProjectState;
  created_at: number;
  updated_at: number;
  target_completion_at: number | null;
  last_activity_at: number;
  related_contact_ids: string;
  parent_project_id: string | null;
}

const rowToProject = (row: ProjectRow): Project => {
  const p: Project = {
    id: row.id,
    title: row.title,
    state: row.state,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_activity_at: row.last_activity_at,
    related_contact_ids: parseStringArray(row.related_contact_ids),
    ...projectSourceRowIdentity(row),
  };
  if (row.description !== null) p.description = row.description;
  if (row.target_completion_at !== null) p.target_completion_at = row.target_completion_at;
  if (row.parent_project_id !== null) p.parent_project_id = row.parent_project_id;
  return p;
};

interface BookingRow extends SourceRowIdentityRow {
  id: string;
  title: string;
  lifecycle_state: BookingLifecycleState;
  state_changed_at: number;
  created_at: number;
  updated_at: number;
  slot_start_at: number | null;
  slot_end_at: number | null;
  monetary_amount: string | null;
  monetary_currency: string | null;
  counterparty_contact_id: string | null;
  reception_record_id: string | null;
}

const rowToBooking = (row: BookingRow): Booking => {
  const b: Booking = {
    id: row.id,
    title: row.title,
    lifecycle_state: row.lifecycle_state,
    created_at: row.created_at,
    updated_at: row.updated_at,
    state_changed_at: row.state_changed_at,
    ...projectSourceRowIdentity(row),
  };
  // Both-or-neither, mirroring the table CHECK. Emitted as a pair so a
  // consumer never has to reason about a start with no end.
  if (row.slot_start_at !== null && row.slot_end_at !== null) {
    b.slot_start_at = row.slot_start_at;
    b.slot_end_at = row.slot_end_at;
  }
  // Both-or-neither, mirroring the table CHECK — a half-populated pair
  // would otherwise surface as a MonetaryValue with an empty currency.
  if (row.monetary_amount !== null && row.monetary_currency !== null) {
    b.monetary_value = { amount: row.monetary_amount, currency: row.monetary_currency };
  }
  if (row.counterparty_contact_id !== null) b.counterparty_contact_id = row.counterparty_contact_id;
  if (row.reception_record_id !== null) b.reception_record_id = row.reception_record_id;
  return b;
};

// ────────────────────────────────────────────────────────────────
// Source registry
// ────────────────────────────────────────────────────────────────

interface SourceRegistryRow {
  id: string;
  top_tier_kind: SourceTopTierKind;
  source_kind: SourceKind;
  source_label: string;
  write_capable: number;
  mcp_exposed: number;
  schema_extension_blob: string | null;
  registered_at: number;
  config_blob: string | null;
  enabled: number;
  sync_posture: string;
}

/** Coerce a persisted `sync_posture` cell to a valid posture, defaulting
 *  `records` for a null / legacy / invalid value (the store-side
 *  `undefined → records` half of the D-192 P-1 optional-field contract). */
const coerceSourceSyncPosture = (v: unknown): SourceSyncPosture =>
  isSourceSyncPosture(v) ? v : 'records';

const rowToSourceRegistration = (row: SourceRegistryRow): SourceRegistration => {
  const reg: SourceRegistration = {
    id: row.id,
    top_tier_kind: row.top_tier_kind,
    source_kind: row.source_kind,
    sync_posture: coerceSourceSyncPosture(row.sync_posture),
    source_label: row.source_label,
    write_capable: intToBool(row.write_capable),
    mcp_exposed: intToBool(row.mcp_exposed),
    enabled: intToBool(row.enabled),
    registered_at: row.registered_at,
  };
  const ext = parseJsonObject(row.schema_extension_blob);
  if (ext) reg.schema_extension_blob = ext;
  const cfg = parseJsonObject(row.config_blob);
  if (cfg) reg.config_blob = cfg;
  return reg;
};

// ────────────────────────────────────────────────────────────────
// Per-kind validators
// ────────────────────────────────────────────────────────────────

const validateText = (
  field: string,
  v: string | undefined,
  max: number,
  required: boolean,
): void => {
  if (v === undefined || v === null) {
    if (required) {
      throw new WorkEntityValidationError(`${field} is required`, field);
    }
    return;
  }
  if (typeof v !== 'string') {
    throw new WorkEntityValidationError(`${field} must be a string`, field);
  }
  if (required && v.length === 0) {
    throw new WorkEntityValidationError(`${field} is required`, field);
  }
  if (v.length > max) {
    throw new WorkEntityValidationError(
      `${field} exceeds max length ${max}`,
      field,
    );
  }
};

const validateTaskInput = (input: TaskWriteInput): void => {
  validateText('title', input.title, TASK_TITLE_MAX, true);
  if (input.priority !== undefined && !TASK_PRIORITY_SET.has(input.priority)) {
    throw new WorkEntityValidationError(
      `unknown priority '${input.priority}'`,
      'priority',
    );
  }
  if (input.due_at !== undefined && !Number.isFinite(input.due_at)) {
    throw new WorkEntityValidationError('due_at must be a finite number', 'due_at');
  }
  if (input.completed_at !== undefined && !Number.isFinite(input.completed_at)) {
    throw new WorkEntityValidationError(
      'completed_at must be a finite number',
      'completed_at',
    );
  }
  // D-179 fork (a) — free-form state (bounded, non-empty) + integer
  // 0–100 progress. No enum, no transition validation by design.
  if (input.state !== undefined) {
    validateText('state', input.state, TASK_STATE_MAX, true);
  }
  if (input.progress !== undefined) {
    if (!Number.isInteger(input.progress) || input.progress < 0 || input.progress > 100) {
      throw new WorkEntityValidationError(
        'progress must be an integer between 0 and 100',
        'progress',
      );
    }
  }
};

const validateNoteInput = (input: NoteWriteInput): void => {
  // `body` must be present but MAY be the empty string: a D-192 P6
  // source-mirrored note never carries complete remote content in the
  // canonical long-body column (the bounded excerpt rides the preview
  // lane in `source_extension_blob`), so the sync fold writes `''`.
  // The non-empty requirement for USER note writes lives in the
  // note-create/update dispatchers (the commitment precedent: shape at
  // the storage layer, semantics at the ingredient layer).
  if ((input.body as string | undefined) === undefined || input.body === null) {
    throw new WorkEntityValidationError('body is required', 'body');
  }
  validateText('body', input.body, Number.MAX_SAFE_INTEGER, false);
  if (input.title !== undefined) {
    validateText('title', input.title, NOTE_TITLE_MAX, false);
  }
};

/** Membership-only validation at PA1 — the lifecycle × due_status
 *  transition table from § A.1.3 is enforced by PA3's kernel CRUD
 *  ingredients (`commitment-fulfill` / `commitment-cancel` /
 *  `commitment-update`), not at the raw storage layer. PA1's
 *  `writeCommitment` is the lowest-level upsert so reconcilers +
 *  test fixtures can populate any valid enum tuple; user-facing
 *  state moves go through the ingredient layer with transition
 *  validation on top. */
/** A booking's counterparty must be an OPAQUE identifier, never the visitor's
 *  address or name.
 *
 *  🔴 Booking-specific ON PURPOSE. `counterparty_contact_id` is shared across
 *  work-entity kinds and `commitment` legitimately keys on an email — so this
 *  cannot move to a column-wide fence. What makes booking different is
 *  `getBookingHistory`: it echoes this value back and renders history to the
 *  owner on the approval, managed-reschedule and detail surfaces, so whatever
 *  lands here becomes part of a privacy-minimal response.
 *
 *  ⛔ The invariant already existed, enforced at ONE call site: the reception
 *  mint deliberately refuses `projectContact`'s `?? email` fallback
 *  (`reception-booking-mint.ts:75-83`). But the kernel `booking-create` /
 *  `booking-update` ingredients pass a caller-supplied value straight through,
 *  so a recipe or a granted agent could put an email in the column and every
 *  later history response would carry it. Enforce at the column, not at the one
 *  writer that happens to get it right. */
const BOOKING_CONTACT_ID_REGEX = /^[A-Za-z0-9._:-]{1,256}$/;

const validateBookingInput = (input: BookingWriteInput): void => {
  validateText('title', input.title, BOOKING_TITLE_MAX, true);
  if (
    input.counterparty_contact_id !== undefined
    && !BOOKING_CONTACT_ID_REGEX.test(input.counterparty_contact_id)
  ) {
    throw new WorkEntityValidationError(
      'counterparty_contact_id must be an opaque identifier '
        + '([A-Za-z0-9._:-], 1-256 chars) — a booking counterparty is resolved '
        + 'through the contact store, never carried as an address or a name',
      'counterparty_contact_id',
    );
  }
  if (
    input.lifecycle_state !== undefined
    && !BOOKING_LIFECYCLE_STATE_SET.has(input.lifecycle_state)
  ) {
    throw new WorkEntityValidationError(
      `unknown lifecycle_state '${input.lifecycle_state}'`,
      'lifecycle_state',
    );
  }
  // Same money contract as `commitment` — one nullable value object,
  // both halves or neither, enforced again by the table CHECK. Reusing
  // the COMMITMENT_* regexes deliberately: they encode the format, not
  // the entity, and a second copy would be a second thing to drift.
  if (input.monetary_value !== undefined) {
    const { amount, currency } = input.monetary_value;
    if (typeof amount !== 'string' || !COMMITMENT_AMOUNT_REGEX.test(amount)) {
      throw new WorkEntityValidationError(
        'monetary_value.amount must be a decimal string at scale 2',
        'monetary_value.amount',
      );
    }
    if (typeof currency !== 'string' || !COMMITMENT_CURRENCY_REGEX.test(currency)) {
      throw new WorkEntityValidationError(
        'monetary_value.currency must be a 3-letter ISO 4217 code',
        'monetary_value.currency',
      );
    }
  }
};

const validateCommitmentInput = (input: CommitmentWriteInput): void => {
  if (!COMMITMENT_DIRECTION_SET.has(input.direction)) {
    throw new WorkEntityValidationError(
      `unknown direction '${input.direction}'`,
      'direction',
    );
  }
  validateText('statement', input.statement, COMMITMENT_STATEMENT_MAX, true);
  if (
    input.lifecycle_state !== undefined
    && !COMMITMENT_LIFECYCLE_STATE_SET.has(input.lifecycle_state)
  ) {
    throw new WorkEntityValidationError(
      `unknown lifecycle_state '${input.lifecycle_state}'`,
      'lifecycle_state',
    );
  }
  if (
    input.due_status !== undefined
    && !COMMITMENT_DUE_STATUS_SET.has(input.due_status)
  ) {
    throw new WorkEntityValidationError(
      `unknown due_status '${input.due_status}'`,
      'due_status',
    );
  }
  if (
    input.expiry_policy !== undefined
    && !COMMITMENT_EXPIRY_POLICY_SET.has(input.expiry_policy)
  ) {
    throw new WorkEntityValidationError(
      `unknown expiry_policy '${input.expiry_policy}'`,
      'expiry_policy',
    );
  }
  if (!COMMITMENT_DERIVATION_SET.has(input.derivation)) {
    throw new WorkEntityValidationError(
      `unknown derivation '${input.derivation}'`,
      'derivation',
    );
  }
  if (
    input.derivation_confidence !== undefined
    && (input.derivation_confidence < 0 || input.derivation_confidence > 1)
  ) {
    throw new WorkEntityValidationError(
      'derivation_confidence must be in [0, 1]',
      'derivation_confidence',
    );
  }
  if (input.monetary_value !== undefined) {
    const { amount, currency } = input.monetary_value;
    if (typeof amount !== 'string' || !COMMITMENT_AMOUNT_REGEX.test(amount)) {
      throw new WorkEntityValidationError(
        'monetary_value.amount must be a decimal string at scale 2',
        'monetary_value.amount',
      );
    }
    if (typeof currency !== 'string' || !COMMITMENT_CURRENCY_REGEX.test(currency)) {
      throw new WorkEntityValidationError(
        'monetary_value.currency must be a 3-letter ISO 4217 code',
        'monetary_value.currency',
      );
    }
  }
  // D-192 F1 — evidence is capture-owned + fail-closed: a present blob
  // must be a NON-EMPTY array of registered-kind entries (invariant 1:
  // no evidence, no commitment — an empty array is a producer bug, not
  // an evidence-less write, which simply omits the field) and its
  // serialized form must fit the cap (over-cap REFUSES — clipped
  // evidence is not the as-was value).
  if (input.evidence_blob !== undefined) {
    if (!Array.isArray(input.evidence_blob) || input.evidence_blob.length === 0) {
      throw new WorkEntityValidationError(
        'evidence_blob must be a non-empty array when present',
        'evidence_blob',
      );
    }
    for (const [i, entry] of input.evidence_blob.entries()) {
      if (!COMMITMENT_EVIDENCE_KIND_SET.has(entry.kind)) {
        throw new WorkEntityValidationError(
          `unknown evidence kind '${String(entry.kind)}'`,
          `evidence_blob[${i}].kind`,
        );
      }
      // Common fields on every family (`CommitmentEvidenceBase`).
      if (typeof entry.full_target_id !== 'string' || entry.full_target_id.length === 0) {
        throw new WorkEntityValidationError(
          'evidence entries must carry a non-empty full_target_id',
          `evidence_blob[${i}].full_target_id`,
        );
      }
      if (typeof entry.captured_at !== 'number' || !Number.isFinite(entry.captured_at)) {
        throw new WorkEntityValidationError(
          'evidence entries must carry a captured_at timestamp',
          `evidence_blob[${i}].captured_at`,
        );
      }
      // Per-family shape (the `kind`-discriminated union). `crm_field`
      // carries the field/value diff; `mail` carries the extraction's
      // source family + actor + bounded paraphrase + confidence.
      if (entry.kind === 'crm_field') {
        if (typeof entry.field !== 'string' || entry.field.length === 0) {
          throw new WorkEntityValidationError(
            'crm_field evidence entries must carry a non-empty field key',
            `evidence_blob[${i}].field`,
          );
        }
        if (typeof entry.value !== 'string' || entry.value.length === 0) {
          throw new WorkEntityValidationError(
            'crm_field evidence entries must carry the non-empty as-was value',
            `evidence_blob[${i}].value`,
          );
        }
      } else if (entry.kind === 'mail') {
        // `mail` — the email flagship's extracted-promise snapshot.
        if (!COMMITMENT_MAIL_EVIDENCE_SOURCE_SET.has(entry.source)) {
          throw new WorkEntityValidationError(
            `mail evidence entries must carry a known source family (got '${String(entry.source)}')`,
            `evidence_blob[${i}].source`,
          );
        }
        // Lightweight actor-email shape guard (a body-shaped string must
        // not ride this slot). The producer-side `CommitmentTrackerSchema`
        // applies the strict RFC-shaped check before the funnel ever
        // reaches here; the store only needs the coarse guard.
        if (
          typeof entry.actor_email !== 'string' ||
          entry.actor_email.length < 3 ||
          entry.actor_email.length > 254 ||
          !entry.actor_email.includes('@') ||
          /\s/.test(entry.actor_email)
        ) {
          throw new WorkEntityValidationError(
            'mail evidence entries must carry a non-empty actor_email (email-shaped, no whitespace)',
            `evidence_blob[${i}].actor_email`,
          );
        }
        if (
          typeof entry.snippet !== 'string' ||
          entry.snippet.length === 0 ||
          entry.snippet.length > COMMITMENT_MAIL_EVIDENCE_SNIPPET_MAX
        ) {
          throw new WorkEntityValidationError(
            `mail evidence entries must carry a non-empty snippet ≤ ${COMMITMENT_MAIL_EVIDENCE_SNIPPET_MAX} chars`,
            `evidence_blob[${i}].snippet`,
          );
        }
        if (
          typeof entry.confidence !== 'number' ||
          !Number.isFinite(entry.confidence) ||
          entry.confidence < 0 ||
          entry.confidence > 1
        ) {
          throw new WorkEntityValidationError(
            'mail evidence entries must carry a confidence in [0, 1]',
            `evidence_blob[${i}].confidence`,
          );
        }
        if (typeof entry.source_at !== 'number' || !Number.isFinite(entry.source_at)) {
          throw new WorkEntityValidationError(
            'mail evidence entries must carry a source_at timestamp',
            `evidence_blob[${i}].source_at`,
          );
        }
      } else {
        // `message` — the messenger flagship's matched-message snapshot
        // (kinds-taxonomy § 3a). `vendor` + `actor_platform_id` are the
        // `(vendor, platform_id)` linker key; `actor_contact_id`,
        // `confidence`, and the base `vendor_url` permalink are optional.
        if (typeof entry.vendor !== 'string' || entry.vendor.length === 0) {
          throw new WorkEntityValidationError(
            'message evidence entries must carry a non-empty vendor',
            `evidence_blob[${i}].vendor`,
          );
        }
        if (
          typeof entry.actor_platform_id !== 'string' ||
          entry.actor_platform_id.length === 0
        ) {
          throw new WorkEntityValidationError(
            'message evidence entries must carry a non-empty actor_platform_id',
            `evidence_blob[${i}].actor_platform_id`,
          );
        }
        if (
          entry.actor_contact_id !== undefined &&
          (typeof entry.actor_contact_id !== 'string' || entry.actor_contact_id.length === 0)
        ) {
          throw new WorkEntityValidationError(
            'message evidence actor_contact_id must be a non-empty string when present',
            `evidence_blob[${i}].actor_contact_id`,
          );
        }
        if (
          typeof entry.snippet !== 'string' ||
          entry.snippet.length === 0 ||
          entry.snippet.length > COMMITMENT_MESSAGE_EVIDENCE_SNIPPET_MAX
        ) {
          throw new WorkEntityValidationError(
            `message evidence entries must carry a non-empty snippet ≤ ${COMMITMENT_MESSAGE_EVIDENCE_SNIPPET_MAX} chars`,
            `evidence_blob[${i}].snippet`,
          );
        }
        if (typeof entry.sent_at !== 'number' || !Number.isFinite(entry.sent_at)) {
          throw new WorkEntityValidationError(
            'message evidence entries must carry a sent_at timestamp',
            `evidence_blob[${i}].sent_at`,
          );
        }
        if (
          entry.confidence !== undefined &&
          (typeof entry.confidence !== 'number' ||
            !Number.isFinite(entry.confidence) ||
            entry.confidence < 0 ||
            entry.confidence > 1)
        ) {
          throw new WorkEntityValidationError(
            'message evidence confidence must be a number in [0, 1] when present',
            `evidence_blob[${i}].confidence`,
          );
        }
      }
    }
    const bytes = Buffer.byteLength(JSON.stringify(input.evidence_blob), 'utf8');
    if (bytes > COMMITMENT_EVIDENCE_BLOB_MAX_BYTES) {
      throw new WorkEntityValidationError(
        `evidence_blob serializes to ${bytes} bytes — cap is ${COMMITMENT_EVIDENCE_BLOB_MAX_BYTES}`,
        'evidence_blob',
      );
    }
  }
};

const validateProjectInput = (input: ProjectWriteInput): void => {
  validateText('title', input.title, PROJECT_TITLE_MAX, true);
  if (input.state !== undefined && !PROJECT_STATE_SET.has(input.state)) {
    throw new WorkEntityValidationError(`unknown state '${input.state}'`, 'state');
  }
};

// ────────────────────────────────────────────────────────────────
// Project hierarchy depth check (§ A.1.4 cap)
// ────────────────────────────────────────────────────────────────

const checkProjectHierarchyDepth = (
  db: Database.Database,
  parent_project_id: string,
  selfId?: string,
): void => {
  let cursor: string | null = parent_project_id;
  let depth = 1;
  const seen = new Set<string>();
  while (cursor) {
    if (selfId && cursor === selfId) {
      throw new WorkEntityValidationError(
        'project hierarchy contains a cycle',
        'parent_project_id',
      );
    }
    if (seen.has(cursor)) {
      throw new WorkEntityValidationError(
        'project hierarchy contains a cycle',
        'parent_project_id',
      );
    }
    seen.add(cursor);
    if (depth >= PROJECT_HIERARCHY_MAX_DEPTH) {
      throw new WorkEntityValidationError(
        `project hierarchy exceeds depth ${PROJECT_HIERARCHY_MAX_DEPTH}`,
        'parent_project_id',
      );
    }
    const next = db
      .prepare(`SELECT parent_project_id FROM ${PROJECT_TABLE} WHERE id = ?`)
      .get(cursor) as { parent_project_id: string | null } | undefined;
    if (!next) break;
    cursor = next.parent_project_id;
    depth += 1;
  }
};

// ────────────────────────────────────────────────────────────────
// Store factory
// ────────────────────────────────────────────────────────────────

interface WorkEntityStoreInternal {
  sourceExists(source_id: string): boolean;
  sourceTopTierKind(source_id: string): SourceTopTierKind | null;
}

export interface WorkEntityStore {
  /** Metadata-only relationship aggregate for one resolved contact. The caller
   * supplies the stable contact id when resolved plus the complete merge/alias address set;
   * storage matches both key spaces because legacy/native task rows use email,
   * while bookings require the opaque id and project arrays may contain either.
   * Disabled, deleted, tombstoned, and orphaned rows follow ordinary list-read
   * visibility. No row bodies or titles leave this boundary. */
  summarizeContactRelationships(input: {
    contact_id?: string;
    emails: readonly string[];
  }): WorkEntityContactRelationshipSummary;
  // ── tasks ──────────────────────────────────────────────────────
  writeTask(input: TaskWriteInput, now?: number): Task;
  /** Atomic create-if-absent for a caller-derived stable local task id. The
   * existing row is returned unchanged; callers verify their idempotency
   * marker before treating it as the same logical task. */
  ensureTask(
    input: TaskWriteInput & { id: string },
    now?: number,
  ): { task: Task; created: boolean };
  readTask(id: string): Task | null;
  listTasks(query?: WorkEntityListQuery): Task[];
  findTask(predicate: (t: Task) => boolean, query?: WorkEntityListQuery): Task | null;
  deleteTask(id: string, opts?: { tombstone?: boolean; now?: number }): boolean;
  countTasks(query?: WorkEntityListQuery): number;
  /** D-145 PA9 — monotonic id-cursor walk over live + stale_unreachable
   *  tasks for the `task_duplicate_candidate` housekeeping producer's
   *  walker. Tombstoned + orphan rows are excluded (mirrors
   *  `listTasks`'s default `sync_states` filter). Order is `id ASC` so
   *  the harness's `max_target_id_seen` cursor resumes deterministically
   *  across yields. */
  walkByTaskId(after_id: string, batch_size: number): Task[];
  /** D-145 PA9 — candidate-narrowed cross-source duplicate lookup.
   *  Returns live + stale_unreachable tasks whose `source_id` differs
   *  from the focal task's, optionally narrowed by
   *  `assigned_contact_id` when supplied (uses
   *  `idx_task_assigned_done` for index-narrowed scan). Result is
   *  capped at `limit` to bound the producer's per-task comparison
   *  budget. The producer ranks the returned candidates client-side
   *  into `exact / probable / low` bands. */
  findCrossSourceTaskCandidates(opts: {
    exclude_source_id: string;
    exclude_task_id: string;
    assigned_contact_id: string | null;
    limit: number;
  }): Task[];
  // ── notes ──────────────────────────────────────────────────────
  writeNote(input: NoteWriteInput, now?: number): Note;
  readNote(id: string): Note | null;
  listNotes(query?: WorkEntityListQuery): Note[];
  findNote(predicate: (n: Note) => boolean, query?: WorkEntityListQuery): Note | null;
  deleteNote(id: string, opts?: { tombstone?: boolean; now?: number }): boolean;
  countNotes(query?: WorkEntityListQuery): number;
  /** D-145 PA9 — monotonic id-cursor walk over live + stale_unreachable
   *  notes for the `note_relevance_decay` housekeeping producer's
   *  walker. Tombstoned + orphan rows are excluded (mirrors
   *  `listNotes`'s default `sync_states` filter). Order is `id ASC` so
   *  the harness's `max_target_id_seen` cursor resumes deterministically
   *  across yields. */
  walkByNoteId(after_id: string, batch_size: number): Note[];
  recordNoteAccess(input: {
    note_id: string;
    accessed_at: number;
    access_kind: NoteAccessKind;
    access_actor?: string;
    metadata_blob?: Record<string, unknown>;
  }): NoteAccessLedgerEntry;
  listNoteAccess(note_id: string, opts?: { limit?: number }): NoteAccessLedgerEntry[];
  // ── commitments ────────────────────────────────────────────────
  writeCommitment(input: CommitmentWriteInput, now?: number): Commitment;
  readCommitment(id: string): Commitment | null;
  listCommitments(query?: WorkEntityListQuery): Commitment[];
  findCommitment(
    predicate: (c: Commitment) => boolean,
    query?: WorkEntityListQuery,
  ): Commitment | null;
  deleteCommitment(id: string, opts?: { tombstone?: boolean; now?: number }): boolean;
  countCommitments(query?: WorkEntityListQuery): number;
  // ── bookings (D-210) ───────────────────────────────────────────
  writeBooking(input: BookingWriteInput, now?: number): Booking;
  readBooking(id: string): Booking | null;
  listBookings(query?: WorkEntityListQuery): Booking[];
  findBooking(
    predicate: (b: Booking) => boolean,
    query?: WorkEntityListQuery,
  ): Booking | null;
  deleteBooking(id: string, opts?: { tombstone?: boolean; now?: number }): boolean;
  countBookings(query?: WorkEntityListQuery): number;
  /** Owner-only prior completed/no-show history for one opaque contact id. */
  getBookingHistory(input: {
    counterparty_contact_id: string;
    exclude_booking_id?: string;
    limit?: number;
  }): BookingHistorySummary;
  // ── projects ───────────────────────────────────────────────────
  writeProject(input: ProjectWriteInput, now?: number): Project;
  readProject(id: string): Project | null;
  listProjects(query?: WorkEntityListQuery): Project[];
  findProject(
    predicate: (p: Project) => boolean,
    query?: WorkEntityListQuery,
  ): Project | null;
  deleteProject(id: string, opts?: { tombstone?: boolean; now?: number }): boolean;
  countProjects(query?: WorkEntityListQuery): number;
  /** D-145 PA9 — monotonic id-cursor walk over live + stale_unreachable
   *  projects for the `project_next_action_gap` housekeeping producer's
   *  walker. Tombstoned + orphan rows are excluded (mirrors
   *  `listProjects`'s default `sync_states` filter). Order is `id ASC` so
   *  the harness's `max_target_id_seen` cursor resumes deterministically
   *  across yields. */
  walkByProjectId(after_id: string, batch_size: number): Project[];
  // ── source registry ────────────────────────────────────────────
  registerSource(reg: Omit<SourceRegistration, 'registered_at'> & { registered_at?: number }): SourceRegistration;
  unregisterSource(id: string): boolean;
  getSource(id: string): SourceRegistration | null;
  listSources(top_tier_kind?: SourceTopTierKind): SourceRegistration[];
  /** D-145 PA11 — flip the user-driven enable/disable toggle. Returns
   *  the post-write Source row; throws `SourceRegistrationError` when
   *  the id is not registered. Idempotent — writing the same value is
   *  a no-op. */
  setSourceEnabled(id: string, enabled: boolean): SourceRegistration;
  /** D-145 PA11 — flip the per-Source MCP exposure boolean. Returns
   *  the post-write Source row; throws when unregistered. The
   *  per-(bound contract, topic) read-visibility override
   *  (`contract.enrichment.*`, D-187) layers on top of this column at MCP
   *  read time; this method only writes the registry-level boolean. */
  setSourceMcpExposed(id: string, mcp_exposed: boolean): SourceRegistration;
  // ── default-Source memory (D-145 PA2 — § A.2.2) ────────────────
  /** Read the per-kind default Source id, or `null` when the user
   *  has not pinned one yet. Backs `prefs.<kind>.last_used_source_id`
   *  in recipe land. */
  getDefaultSource(kind: WorkEntityKind): string | null;
  /** Pin the default Source id for a kind. The Source must be
   *  registered for that kind — cross-kind / unknown ids reject. */
  setDefaultSource(kind: WorkEntityKind, source_id: string, now?: number): void;
  /** Drop the per-kind default. No-op when nothing was set. */
  clearDefaultSource(kind: WorkEntityKind): boolean;
  // ── polymorphic ────────────────────────────────────────────────
  /** Generic by-kind read. Returns the row tagged with `_kind`. */
  readByKind<K extends WorkEntityKind>(kind: K, id: string): WorkEntity | null;
  /** Resolve the stable mirror identity emitted at tool boundaries. The
   *  `(source_id, source_record_id)` pair is unique within each kind table;
   *  unlike a local row id it can also be handed safely to a provider tool. */
  readBySourceIdentity(
    kind: WorkEntityKind,
    source_id: string,
    source_record_id: string,
  ): WorkEntity | null;
  countByKind(kind: WorkEntityKind, query?: WorkEntityListQuery): number;
  /** Generic by-kind list across all Sources (or one when
   *  `query.source_id` is set). Returns rows tagged with `_kind`. */
  listByKind(kind: WorkEntityKind, query?: WorkEntityListQuery): WorkEntity[];
  // ── D-192 source-data purge (source-data-removal on teardown) ───
  /** D-192 — enumerate the canonical-record identities `(kind, id)` for
   *  a Source across all four work-entity tables, in EVERY sync_state
   *  (live / stale_unreachable / orphaned / tombstoned). The purge
   *  orchestrator reads this BEFORE `deleteRecordsForSource` to cascade
   *  each record's live-derived data (annotations / links / enrichments
   *  are keyed `(collection = kind, target_id = row id)`). Unbounded — a
   *  Source teardown reaps its whole record set. A source_id is
   *  kind-specific by construction (`<vendor>.<conn>.<kind>`), so in
   *  practice every returned row shares one kind; the cross-table walk
   *  mirrors `unregisterSource` and stays correct regardless. */
  listRecordIdentitiesForSource(source_id: string): Array<{ kind: WorkEntityKind; id: string }>;
  /** D-192 — hard-delete EVERY canonical row for a Source across the
   *  four work-entity tables, regardless of sync_state (an already-
   *  orphaned row from a prior `unregisterSource` is deleted too). This
   *  is the opt-in teardown purge (the "also remove the mirrored data"
   *  path), distinct from `unregisterSource` which orphan-flips +
   *  preserves. One transaction; returns total rows deleted; idempotent
   *  (a re-run deletes 0). Does NOT touch derived data — the orchestrator
   *  cascades annotations / links / enrichments separately. */
  deleteRecordsForSource(source_id: string): number;
  /** D-192 — count the canonical rows a Source teardown would purge
   *  (all sync_states), for the removal-dialog "[N] records" preview.
   *  Cheap COUNT; no row materialization. */
  countRecordsForSource(source_id: string): number;
  // ── dirty-write state (D-192 P4 — spec § Conflict model) ───────
  /** Stage a Recued-originated dirty-write on a row. A DEDICATED
   *  channel, deliberately outside the full-row upsert column set: a
   *  sync-cycle upsert or a dispatcher patch must never silently
   *  clear a staged local edit. Overwrites any prior staged state
   *  (the P4 write executor owns the lifecycle). False when the row
   *  does not exist. */
  stagePendingWrite(
    kind: WorkEntityKind,
    id: string,
    pending: WorkEntityPendingWrite,
  ): boolean;
  /** Clear the row's dirty-write state (vendor acknowledged /
   *  post-write verified / edit abandoned). False when the row does
   *  not exist or carried no pending write. */
  clearPendingWrite(kind: WorkEntityKind, id: string): boolean;
}

export interface CreateWorkEntityStoreOptions {
  newId?: () => string;
}

export const createWorkEntityStore = (
  db: Database.Database,
  opts: CreateWorkEntityStoreOptions = {},
): WorkEntityStore => {
  // A store may be built on a connection whose schema was ensured elsewhere (or
  // by a test helper); the search predicate needs `js_lower` on THIS connection.
  registerWorkEntitySqlFunctions(db);
  const newId = opts.newId ?? ((): string => randomUUID());

  // ── source registry helpers ─────────────────────────────────────
  const sourceExistsStmt = db.prepare(
    `SELECT 1 FROM ${SOURCE_REGISTRY_TABLE} WHERE id = ?`,
  );
  const sourceKindStmt = db.prepare(
    `SELECT top_tier_kind FROM ${SOURCE_REGISTRY_TABLE} WHERE id = ?`,
  );
  const internal: WorkEntityStoreInternal = {
    sourceExists: (id) => sourceExistsStmt.get(id) !== undefined,
    sourceTopTierKind: (id) => {
      const row = sourceKindStmt.get(id) as { top_tier_kind: SourceTopTierKind } | undefined;
      return row ? row.top_tier_kind : null;
    },
  };

  // D-145 PA3 — `registerSource` upgraded to UPSERT semantics so the
  // first-dispatch capability probe can flip `write_capable: false →
  // true` in-place without a separate `updateSource` method. PA2 only
  // ever inserted (idempotent + skip-when-present at the boot wire);
  // PA3's connection-Source probe needs to mutate `write_capable` (and
  // optionally `source_label` / `schema_extension_blob` / `config_blob`)
  // when scope is confirmed at first vendor write. `registered_at`
  // preservation is intentional: re-registering doesn't move the
  // first-seen timestamp (the boot wire's idempotent register would
  // otherwise drift it on every restart). `top_tier_kind` is locked on
  // first insert — flipping a Source's kind after registration would
  // strand any rows referencing the prior kind, so we reject the change
  // explicitly instead of silently overwriting.
  // D-145 PA11 — `registerSource` does NOT overwrite `enabled` on
  // UPSERT. The user-driven enable/disable toggle (Settings → Work
  // Entities) must survive boot-wire re-registration; otherwise every
  // server restart would silently re-enable a Source the user
  // disabled. The insert path defaults to `enabled = 1` for
  // first-registration; the conflict path leaves the column alone.
  const insertSourceStmt = db.prepare(`
    INSERT INTO ${SOURCE_REGISTRY_TABLE}
      (id, top_tier_kind, source_kind, source_label, write_capable,
       mcp_exposed, schema_extension_blob, registered_at, config_blob,
       enabled, sync_posture)
    VALUES
      (@id, @top_tier_kind, @source_kind, @source_label, @write_capable,
       @mcp_exposed, @schema_extension_blob, @registered_at, @config_blob,
       @enabled, @sync_posture)
    ON CONFLICT(id) DO UPDATE SET
      source_kind            = excluded.source_kind,
      source_label           = excluded.source_label,
      write_capable          = excluded.write_capable,
      mcp_exposed            = excluded.mcp_exposed,
      schema_extension_blob  = excluded.schema_extension_blob,
      config_blob            = excluded.config_blob,
      sync_posture           = CASE
        WHEN @sync_posture_supplied = 1 THEN excluded.sync_posture
        ELSE sync_posture
      END
  `);
  const getSourceStmt = db.prepare(
    `SELECT * FROM ${SOURCE_REGISTRY_TABLE} WHERE id = ?`,
  );

  const registerSource: WorkEntityStore['registerSource'] = (reg) => {
    if (typeof reg.id !== 'string' || reg.id.length === 0) {
      throw new SourceRegistrationError('id is required');
    }
    if (!SOURCE_TOP_TIER_KIND_SET.has(reg.top_tier_kind)) {
      throw new SourceRegistrationError(`unknown top_tier_kind '${reg.top_tier_kind}'`);
    }
    if (!SOURCE_KIND_SET.has(reg.source_kind)) {
      throw new SourceRegistrationError(`unknown source_kind '${reg.source_kind}'`);
    }
    if (reg.sync_posture !== undefined && !isSourceSyncPosture(reg.sync_posture)) {
      throw new SourceRegistrationError(`unknown sync_posture '${String(reg.sync_posture)}'`);
    }
    if (typeof reg.source_label !== 'string' || reg.source_label.length === 0) {
      throw new SourceRegistrationError('source_label is required');
    }
    const existing = internal.sourceTopTierKind(reg.id);
    if (existing !== null && existing !== reg.top_tier_kind) {
      throw new SourceRegistrationError(
        `source_id '${reg.id}' is already registered for top_tier_kind '${existing}'; cannot re-register as '${reg.top_tier_kind}'`,
      );
    }
    const existingRow = existing !== null ? getSourceStmt.get(reg.id) as SourceRegistryRow | undefined : undefined;
    // Preserve `registered_at` on UPSERT — re-registering doesn't move
    // the first-seen timestamp (boot-wire idempotent re-registers would
    // otherwise drift it on every restart).
    const registered_at = existingRow ? existingRow.registered_at : (reg.registered_at ?? Date.now());
    // D-145 PA11 — first-registration default `enabled = 1`. UPSERT's
    // ON CONFLICT clause omits `enabled` so the user toggle survives
    // boot-wire re-registers. Caller-supplied `reg.enabled` only takes
    // effect on first insert; subsequent registers keep the persisted
    // value. The bound parameter still has to be supplied because
    // better-sqlite3 doesn't allow named-parameter omission.
    const enabledFirstInsert = reg.enabled === false ? 0 : 1;
    insertSourceStmt.run({
      id: reg.id,
      top_tier_kind: reg.top_tier_kind,
      source_kind: reg.source_kind,
      source_label: reg.source_label,
      write_capable: reg.write_capable ? 1 : 0,
      mcp_exposed: reg.mcp_exposed ? 1 : 0,
      schema_extension_blob: stringifyJsonObject(reg.schema_extension_blob),
      registered_at,
      config_blob: stringifyJsonObject(reg.config_blob),
      enabled: enabledFirstInsert,
      // D-192 P-1 — first-insert posture (default `records`). On conflict an
      // omitted posture preserves the structural value (capability probes and
      // old callers must not reset it); an explicit declaration posture updates
      // it so a pack declaration update/reinstall can migrate records ↔
      // read-through deliberately. There is no user/runtime posture toggle.
      sync_posture: reg.sync_posture ?? 'records',
      sync_posture_supplied: reg.sync_posture === undefined ? 0 : 1,
    });
    // Re-read the row so we surface the actual persisted `enabled`
    // value (the conflict path may have preserved a prior toggle).
    const persisted = getSourceStmt.get(reg.id) as SourceRegistryRow;
    const out: SourceRegistration = {
      id: reg.id,
      top_tier_kind: reg.top_tier_kind,
      source_kind: reg.source_kind,
      sync_posture: coerceSourceSyncPosture(persisted.sync_posture),
      source_label: reg.source_label,
      write_capable: reg.write_capable,
      mcp_exposed: reg.mcp_exposed,
      enabled: intToBool(persisted.enabled),
      registered_at,
    };
    if (reg.schema_extension_blob) out.schema_extension_blob = reg.schema_extension_blob;
    if (reg.config_blob) out.config_blob = reg.config_blob;
    return out;
  };

  const unregisterSource: WorkEntityStore['unregisterSource'] = (id) => {
    // § A.1.6 — when a Source is unregistered, dependent rows
    // transition to `sync_state: 'orphaned'` (preserved for audit +
    // cascade history), not deleted. The polymorphic resolver's
    // default "All Sources" filter already excludes orphaned rows;
    // explicit queries can still read them via `sync_states:
    // ['orphaned']`. Run inside a transaction so the orphan flip and
    // the registry delete commit atomically.
    const tx = db.transaction((sourceId: string): boolean => {
      const now = Date.now();
      for (const table of [TASK_TABLE, NOTE_TABLE, COMMITMENT_TABLE, PROJECT_TABLE]) {
        // Skip rows already tombstoned — those carry their own
        // deleted_at + sync_state that the orphan flip should not
        // overwrite. Live + stale_unreachable rows flip to orphaned.
        db.prepare(
          `UPDATE ${table}
             SET sync_state = 'orphaned', updated_at = ?
           WHERE source_id = ? AND sync_state IN ('live', 'stale_unreachable')`,
        ).run(now, sourceId);
      }
      const result = db
        .prepare(`DELETE FROM ${SOURCE_REGISTRY_TABLE} WHERE id = ?`)
        .run(sourceId);
      return result.changes > 0;
    });
    return tx(id);
  };

  // D-192 source-data purge — the opt-in "also remove the mirrored
  // data" teardown path. `unregisterSource` (above) orphan-flips +
  // preserves the rows (the default, unchecked); these hard-delete
  // them when the user opts in. Prepared once at factory init.
  const purgeIdentityStmts = WORK_ENTITY_KINDS.map((kind) => ({
    kind,
    stmt: db.prepare(`SELECT id FROM ${TABLE_FOR_KIND[kind]} WHERE source_id = ?`),
  }));
  const purgeDeleteStmts = WORK_ENTITY_KINDS.map((kind) =>
    db.prepare(`DELETE FROM ${TABLE_FOR_KIND[kind]} WHERE source_id = ?`),
  );
  // Notes carry a `note_access_ledger` child with `note_id NOT NULL
  // REFERENCES data_note(id)` — under the app's `foreign_keys = ON`
  // (compose-storage-context), deleting the note rows first raises a FK
  // violation. Clear the ledger for this Source's notes first, exactly
  // as the single-note hard-delete does.
  const purgeNoteLedgerStmt = db.prepare(
    `DELETE FROM ${NOTE_ACCESS_LEDGER_TABLE}
       WHERE note_id IN (SELECT id FROM ${NOTE_TABLE} WHERE source_id = ?)`,
  );
  const countRecordsForSourceStmt = db.prepare(
    `SELECT
         (SELECT COUNT(*) FROM ${TASK_TABLE} WHERE source_id = ?)
       + (SELECT COUNT(*) FROM ${NOTE_TABLE} WHERE source_id = ?)
       + (SELECT COUNT(*) FROM ${COMMITMENT_TABLE} WHERE source_id = ?)
       + (SELECT COUNT(*) FROM ${PROJECT_TABLE} WHERE source_id = ?) AS n`,
  );

  const listRecordIdentitiesForSource: WorkEntityStore['listRecordIdentitiesForSource'] = (
    source_id,
  ) => {
    const out: Array<{ kind: WorkEntityKind; id: string }> = [];
    for (const { kind, stmt } of purgeIdentityStmts) {
      for (const row of stmt.all(source_id) as Array<{ id: string }>) {
        out.push({ kind, id: row.id });
      }
    }
    return out;
  };

  const deleteRecordsForSource: WorkEntityStore['deleteRecordsForSource'] = (source_id) => {
    const tx = db.transaction((sid: string): number => {
      // FK-satisfying child cleanup before the parent note rows.
      purgeNoteLedgerStmt.run(sid);
      let total = 0;
      for (const stmt of purgeDeleteStmts) total += stmt.run(sid).changes;
      return total;
    });
    return tx(source_id);
  };

  const countRecordsForSource: WorkEntityStore['countRecordsForSource'] = (source_id) =>
    (countRecordsForSourceStmt.get(source_id, source_id, source_id, source_id) as { n: number }).n;

  const getSource: WorkEntityStore['getSource'] = (id) => {
    const row = getSourceStmt.get(id) as SourceRegistryRow | undefined;
    return row ? rowToSourceRegistration(row) : null;
  };

  const listSources: WorkEntityStore['listSources'] = (kind) => {
    const rows = (kind
      ? db
          .prepare(
            `SELECT * FROM ${SOURCE_REGISTRY_TABLE} WHERE top_tier_kind = ? ORDER BY registered_at`,
          )
          .all(kind)
      : db.prepare(`SELECT * FROM ${SOURCE_REGISTRY_TABLE} ORDER BY registered_at`).all()) as SourceRegistryRow[];
    return rows.map(rowToSourceRegistration);
  };

  // D-145 PA11 — user-toggle setters for the Settings → Work Entities
  // panel. Both methods validate the Source is registered, write the
  // single column, and return the post-write registration row. The
  // mutation is column-scoped (no UPSERT) so concurrent writes against
  // the same Source row don't clobber unrelated columns.
  const setSourceEnabledStmt = db.prepare(
    `UPDATE ${SOURCE_REGISTRY_TABLE} SET enabled = ? WHERE id = ?`,
  );
  const setSourceMcpExposedStmt = db.prepare(
    `UPDATE ${SOURCE_REGISTRY_TABLE} SET mcp_exposed = ? WHERE id = ?`,
  );

  // D-145 PA11 Codex P1 fold (finding 5) — disabling a Source that is
  // currently the per-kind default auto-clears the default. Otherwise
  // the create-dialog would silently route to a disabled Source on
  // its next open. Single transaction so the pair commits atomically.
  const clearDefaultsForDisabledSourceStmt = db.prepare(
    `DELETE FROM ${WORK_ENTITY_DEFAULT_SOURCE_TABLE} WHERE source_id = ?`,
  );

  const setSourceEnabled: WorkEntityStore['setSourceEnabled'] = (id, enabled) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SourceRegistrationError('id is required');
    }
    if (typeof enabled !== 'boolean') {
      throw new SourceRegistrationError('enabled must be a boolean');
    }
    const tx = db.transaction((): SourceRegistryRow => {
      const result = setSourceEnabledStmt.run(enabled ? 1 : 0, id);
      if (result.changes === 0) {
        throw new SourceRegistrationError(
          `source_id '${id}' is not registered in source_registry`,
        );
      }
      // Auto-clear any pinned default that points at this Source on
      // disable. This is a single statement that drops the row if
      // present and is a no-op otherwise.
      if (!enabled) {
        clearDefaultsForDisabledSourceStmt.run(id);
      }
      return getSourceStmt.get(id) as SourceRegistryRow;
    });
    return rowToSourceRegistration(tx());
  };

  const setSourceMcpExposed: WorkEntityStore['setSourceMcpExposed'] = (
    id,
    mcp_exposed,
  ) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SourceRegistrationError('id is required');
    }
    if (typeof mcp_exposed !== 'boolean') {
      throw new SourceRegistrationError('mcp_exposed must be a boolean');
    }
    const result = setSourceMcpExposedStmt.run(mcp_exposed ? 1 : 0, id);
    if (result.changes === 0) {
      throw new SourceRegistrationError(
        `source_id '${id}' is not registered in source_registry`,
      );
    }
    const row = getSourceStmt.get(id) as SourceRegistryRow;
    return rowToSourceRegistration(row);
  };

  // ── default-Source memory (PA2 — § A.2.2) ───────────────────────
  const getDefaultSourceStmt = db.prepare(
    `SELECT source_id FROM ${WORK_ENTITY_DEFAULT_SOURCE_TABLE} WHERE kind = ?`,
  );
  const upsertDefaultSourceStmt = db.prepare(
    `INSERT INTO ${WORK_ENTITY_DEFAULT_SOURCE_TABLE} (kind, source_id, updated_at)
       VALUES (?, ?, ?)
     ON CONFLICT(kind) DO UPDATE SET
       source_id = excluded.source_id,
       updated_at = excluded.updated_at`,
  );
  const deleteDefaultSourceStmt = db.prepare(
    `DELETE FROM ${WORK_ENTITY_DEFAULT_SOURCE_TABLE} WHERE kind = ?`,
  );

  const getDefaultSource: WorkEntityStore['getDefaultSource'] = (kind) => {
    if (!WORK_ENTITY_KIND_SET.has(kind)) {
      throw new WorkEntityValidationError(`unknown kind '${kind}'`, 'kind');
    }
    const row = getDefaultSourceStmt.get(kind) as { source_id: string } | undefined;
    return row ? row.source_id : null;
  };

  const setDefaultSource: WorkEntityStore['setDefaultSource'] = (
    kind,
    source_id,
    now = Date.now(),
  ) => {
    if (!WORK_ENTITY_KIND_SET.has(kind)) {
      throw new WorkEntityValidationError(`unknown kind '${kind}'`, 'kind');
    }
    if (typeof source_id !== 'string' || source_id.length === 0) {
      throw new WorkEntityValidationError('source_id is required', 'source_id');
    }
    // D-145 PA11 Codex P1 fold (finding 5) — refuse to pin a disabled
    // Source. Pinning + then disabling is handled by the auto-clear
    // path on `setSourceEnabled`, but the inverse (pin a Source the
    // user already disabled) would silently route create-dialog
    // writes to a disabled Source. Read the full row up-front so the
    // existence + kind + enabled checks can short-circuit with typed
    // errors before the upsert runs.
    const sourceRow = getSourceStmt.get(source_id) as SourceRegistryRow | undefined;
    if (sourceRow === undefined) {
      throw new WorkEntityValidationError(
        `source_id '${source_id}' is not registered in source_registry`,
        'source_id',
      );
    }
    if (sourceRow.top_tier_kind !== kind) {
      throw new WorkEntityValidationError(
        `source_id '${source_id}' is registered for top_tier_kind '${sourceRow.top_tier_kind}', not '${kind}'`,
        'source_id',
      );
    }
    if (sourceRow.enabled === 0) {
      throw new WorkEntityValidationError(
        `source_id '${source_id}' is disabled; enable it before pinning as default`,
        'source_id',
      );
    }
    // § A.2 per-kind scoping mirrors `resolveSourceIdentity`: pinning a
    // task default to a note Source is the same kind-cross that breaks
    // the polymorphic resolver invariant. Reject at write time.
    const registeredKind = internal.sourceTopTierKind(source_id);
    if (registeredKind === null) {
      throw new WorkEntityValidationError(
        `source_id '${source_id}' is not registered in source_registry`,
        'source_id',
      );
    }
    if (registeredKind !== kind) {
      throw new WorkEntityValidationError(
        `source_id '${source_id}' is registered for top_tier_kind '${registeredKind}', not '${kind}'`,
        'source_id',
      );
    }
    upsertDefaultSourceStmt.run(kind, source_id, now);
  };

  const clearDefaultSource: WorkEntityStore['clearDefaultSource'] = (kind) => {
    if (!WORK_ENTITY_KIND_SET.has(kind)) {
      throw new WorkEntityValidationError(`unknown kind '${kind}'`, 'kind');
    }
    const result = deleteDefaultSourceStmt.run(kind);
    return result.changes > 0;
  };

  // ── tasks ───────────────────────────────────────────────────────
  const writeTask: WorkEntityStore['writeTask'] = (input, now = Date.now()) => {
    validateTaskInput(input);
    const id = input.id ?? newId();
    const created_at = input.created_at ?? now;
    const updated_at = input.updated_at ?? now;
    const sri = resolveSourceIdentity(input, now, internal, 'task');
    const completed_at = input.completed_at ?? (input.done ? now : undefined);
    db.prepare(
      `INSERT INTO ${TASK_TABLE}
         (id, title, body, done, due_at, priority, created_at, updated_at,
          completed_at, assigned_contact_id, parent_calendar_event_id,
          linked_mail_thread_id, parent_project_id, blocks_task_ids,
          state, progress,
          source_id, source_record_id, connection_id, source_updated_at,
          last_seen_at, deleted_at, sync_state, conflict_policy,
          source_record_hash, source_extension_blob, source_version_token)
       VALUES
         (@id, @title, @body, @done, @due_at, @priority, @created_at, @updated_at,
          @completed_at, @assigned_contact_id, @parent_calendar_event_id,
          @linked_mail_thread_id, @parent_project_id, @blocks_task_ids,
          @state, @progress,
          @source_id, @source_record_id, @connection_id, @source_updated_at,
          @last_seen_at, @deleted_at, @sync_state, @conflict_policy,
          @source_record_hash, @source_extension_blob, @source_version_token)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         done = excluded.done,
         due_at = excluded.due_at,
         priority = excluded.priority,
         updated_at = excluded.updated_at,
         completed_at = excluded.completed_at,
         assigned_contact_id = excluded.assigned_contact_id,
         parent_calendar_event_id = excluded.parent_calendar_event_id,
         linked_mail_thread_id = excluded.linked_mail_thread_id,
         parent_project_id = excluded.parent_project_id,
         blocks_task_ids = excluded.blocks_task_ids,
         state = excluded.state,
         progress = excluded.progress,
         source_id = excluded.source_id,
         source_record_id = excluded.source_record_id,
         connection_id = excluded.connection_id,
         source_updated_at = excluded.source_updated_at,
         last_seen_at = excluded.last_seen_at,
         deleted_at = excluded.deleted_at,
         sync_state = excluded.sync_state,
         conflict_policy = excluded.conflict_policy,
         source_record_hash = excluded.source_record_hash,
         source_extension_blob = excluded.source_extension_blob,
         source_version_token = excluded.source_version_token`,
    ).run({
      id,
      title: input.title,
      body: input.body ?? null,
      done: boolToInt(input.done, false),
      due_at: input.due_at ?? null,
      priority: input.priority ?? null,
      created_at,
      updated_at,
      completed_at: completed_at ?? null,
      assigned_contact_id: input.assigned_contact_id ?? null,
      parent_calendar_event_id: input.parent_calendar_event_id ?? null,
      linked_mail_thread_id: input.linked_mail_thread_id ?? null,
      parent_project_id: input.parent_project_id ?? null,
      blocks_task_ids: stringifyArray(input.blocks_task_ids),
      state: input.state ?? null,
      progress: input.progress ?? null,
      source_id: sri.source_id,
      source_record_id: sri.source_record_id,
      connection_id: sri.connection_id,
      source_updated_at: sri.source_updated_at,
      last_seen_at: sri.last_seen_at,
      deleted_at: sri.deleted_at,
      sync_state: sri.sync_state,
      conflict_policy: sri.conflict_policy,
      source_record_hash: sri.source_record_hash,
      source_extension_blob: sri.source_extension_blob,
      source_version_token: sri.source_version_token,
    });
    const written = readTask(id);
    if (!written) throw new Error(`writeTask: row ${id} missing post-insert`);
    return written;
  };

  const readTask: WorkEntityStore['readTask'] = (id) => {
    const row = db.prepare(`SELECT * FROM ${TASK_TABLE} WHERE id = ?`).get(id) as
      | TaskRow
      | undefined;
    return row ? rowToTask(row) : null;
  };

  const ensureTask: WorkEntityStore['ensureTask'] = (input, now = Date.now()) => {
    validateTaskInput(input);
    if (input.id.length === 0) {
      throw new WorkEntityValidationError('id is required', 'id');
    }
    const apply = db.transaction((): { task: Task; created: boolean } => {
      const existing = readTask(input.id);
      if (existing !== null) return { task: existing, created: false };
      return { task: writeTask(input, now), created: true };
    });
    // Acquire the writer lock before the read so two server processes cannot
    // both observe absence and emit two logical creates for the same key.
    return apply.immediate();
  };

  const listTasks: WorkEntityStore['listTasks'] = (q) => {
    const norm = normalizeListQuery(q);
    const where = buildListWhere(norm, false, true);
    const rows = db
      .prepare(
        `SELECT * FROM ${TASK_TABLE} ${where.sql}
         ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...where.params, norm.limit, norm.offset) as TaskRow[];
    return rows.map(rowToTask);
  };

  const findTask: WorkEntityStore['findTask'] = (predicate, q) => {
    for (const t of listTasks(q)) {
      if (predicate(t)) return t;
    }
    return null;
  };

  const deleteTask: WorkEntityStore['deleteTask'] = (id, opts) => {
    if (opts?.tombstone) {
      const now = opts.now ?? Date.now();
      const result = db
        .prepare(
          `UPDATE ${TASK_TABLE}
           SET sync_state = 'tombstoned', deleted_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, id);
      return result.changes > 0;
    }
    const result = db.prepare(`DELETE FROM ${TASK_TABLE} WHERE id = ?`).run(id);
    return result.changes > 0;
  };

  const countTasks: WorkEntityStore['countTasks'] = (q) => {
    const norm = normalizeListQuery(q);
    const where = buildListWhere(norm, false, true);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${TASK_TABLE} ${where.sql}`)
      .get(...where.params) as { n: number };
    return row.n;
  };

  const walkByTaskIdStmt = db.prepare(
    `SELECT * FROM ${TASK_TABLE}
       WHERE id > ?
         AND sync_state IN ('live', 'stale_unreachable')
       ORDER BY id ASC
       LIMIT ?`,
  );
  const walkByTaskId: WorkEntityStore['walkByTaskId'] = (after_id, batch_size) => {
    const safe = Math.max(1, Math.min(batch_size, MAX_LIST_LIMIT));
    const rows = walkByTaskIdStmt.all(after_id, safe) as TaskRow[];
    return rows.map(rowToTask);
  };

  // D-145 PA9 — cross-source candidate query for
  // `task_duplicate_candidate`. Two prepared variants: assigned (uses
  // `idx_task_assigned_done` for index-narrowed scan) + unassigned
  // (table scan bounded by `LIMIT`; unassigned tasks are less common
  // and a hard cap keeps the producer's per-task budget tight).
  const findCrossSourceTasksAssignedStmt = db.prepare(
    `SELECT * FROM ${TASK_TABLE}
       WHERE assigned_contact_id = ?
         AND source_id != ?
         AND id != ?
         AND sync_state IN ('live', 'stale_unreachable')
         AND deleted_at IS NULL
       ORDER BY id ASC
       LIMIT ?`,
  );
  const findCrossSourceTasksUnassignedStmt = db.prepare(
    `SELECT * FROM ${TASK_TABLE}
       WHERE assigned_contact_id IS NULL
         AND source_id != ?
         AND id != ?
         AND sync_state IN ('live', 'stale_unreachable')
         AND deleted_at IS NULL
       ORDER BY id ASC
       LIMIT ?`,
  );
  const findCrossSourceTaskCandidates: WorkEntityStore['findCrossSourceTaskCandidates'] = (opts) => {
    const safe = Math.max(1, Math.min(opts.limit, MAX_LIST_LIMIT));
    // D-205 #3.5 — `assigned_contact_id` holds an EMAIL, and a merge leaves each
    // task keyed on whichever address it was assigned under. Narrowing on the
    // survivor's address alone would miss the duplicate whose twin was assigned
    // under an address the same person has since merged away — i.e. it would
    // fail to spot a duplicate for the very reason the two records ARE the same
    // person. The set is `[the address]` at zero merges, so the prepared
    // single-address statement above still serves the common case.
    const assigned = opts.assigned_contact_id;
    const rows = (assigned !== null && assigned !== ''
      ? (() => {
          const addresses = contactAddressSet(db, assigned);
          if (addresses.length <= 1) {
            return findCrossSourceTasksAssignedStmt.all(
              addresses[0] ?? assigned,
              opts.exclude_source_id,
              opts.exclude_task_id,
              safe,
            );
          }
          return db
            .prepare(
              `SELECT * FROM ${TASK_TABLE}
                 WHERE assigned_contact_id IN (${addresses.map(() => '?').join(', ')})
                   AND source_id != ?
                   AND id != ?
                   AND sync_state IN ('live', 'stale_unreachable')
                   AND deleted_at IS NULL
                 ORDER BY id ASC
                 LIMIT ?`,
            )
            .all(...addresses, opts.exclude_source_id, opts.exclude_task_id, safe);
        })()
      : findCrossSourceTasksUnassignedStmt.all(
          opts.exclude_source_id,
          opts.exclude_task_id,
          safe,
        )) as TaskRow[];
    return rows.map(rowToTask);
  };

  const emptyRelationshipCounts = (): WorkEntityRelationshipCounts => ({
    active_count: 0,
    historical_count: 0,
    observed_count: 0,
  });
  const relationshipCounts = (row: {
    active_count: number | null;
    historical_count: number | null;
    observed_count: number;
  } | undefined): WorkEntityRelationshipCounts => row
    ? {
        active_count: row.active_count ?? 0,
        historical_count: row.historical_count ?? 0,
        observed_count: row.observed_count,
      }
    : emptyRelationshipCounts();
  const relationshipVisible = buildListWhere(normalizeListQuery({ limit: 1 }));
  const summarizeTaskRelationshipsStmt = db.prepare(
    `SELECT
       SUM(CASE WHEN done = 0 THEN 1 ELSE 0 END) AS active_count,
       SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END) AS historical_count,
       COUNT(*) AS observed_count
     FROM ${TASK_TABLE} ${relationshipVisible.sql}
       AND assigned_contact_id IN (SELECT value FROM json_each(?))`,
  );
  const summarizeBookingRelationshipsStmt = db.prepare(
    `SELECT
       SUM(CASE WHEN lifecycle_state IN ('pending', 'confirmed') THEN 1 ELSE 0 END) AS active_count,
       SUM(CASE WHEN lifecycle_state IN ('completed', 'cancelled', 'no_show') THEN 1 ELSE 0 END) AS historical_count,
       COUNT(*) AS observed_count
     FROM ${BOOKING_TABLE} ${relationshipVisible.sql}
       AND counterparty_contact_id IN (SELECT value FROM json_each(?))`,
  );
  const summarizeProjectRelationshipsStmt = db.prepare(
    `SELECT
       SUM(CASE WHEN state IN ('active', 'paused') THEN 1 ELSE 0 END) AS active_count,
       SUM(CASE WHEN state IN ('completed', 'archived') THEN 1 ELSE 0 END) AS historical_count,
       COUNT(*) AS observed_count
     FROM ${PROJECT_TABLE} ${relationshipVisible.sql}
       AND EXISTS (
         SELECT 1 FROM json_each(${PROJECT_TABLE}.related_contact_ids) AS related
          WHERE related.value IN (SELECT value FROM json_each(?))
       )`,
  );
  const summarizeContactRelationships: WorkEntityStore['summarizeContactRelationships'] = (
    input,
  ) => {
    const identifiers = [...new Set([
      input.contact_id ?? '',
      ...input.emails,
    ].filter((value) => value.length > 0))];
    if (identifiers.length === 0) {
      return {
        tasks: emptyRelationshipCounts(),
        bookings: emptyRelationshipCounts(),
        projects: emptyRelationshipCounts(),
      };
    }
    // One JSON parameter keeps the query complete even for a contact with a large
    // merge/alias address set; expanding a `?` per address would eventually hit
    // SQLite's bound-variable ceiling and turn "many aliases" into a partial read.
    const identifiersJson = JSON.stringify(identifiers);
    const task = summarizeTaskRelationshipsStmt.get(
      ...relationshipVisible.params,
      identifiersJson,
    ) as {
      active_count: number | null;
      historical_count: number | null;
      observed_count: number;
    } | undefined;
    const booking = summarizeBookingRelationshipsStmt.get(
      ...relationshipVisible.params,
      identifiersJson,
    ) as {
      active_count: number | null;
      historical_count: number | null;
      observed_count: number;
    } | undefined;
    const project = summarizeProjectRelationshipsStmt.get(
      ...relationshipVisible.params,
      identifiersJson,
    ) as {
      active_count: number | null;
      historical_count: number | null;
      observed_count: number;
    } | undefined;
    return {
      tasks: relationshipCounts(task),
      bookings: relationshipCounts(booking),
      projects: relationshipCounts(project),
    };
  };

  // ── notes ───────────────────────────────────────────────────────
  const writeNote: WorkEntityStore['writeNote'] = (input, now = Date.now()) => {
    validateNoteInput(input);
    const id = input.id ?? newId();
    const created_at = input.created_at ?? now;
    const updated_at = input.updated_at ?? now;
    const last_user_action_at = input.last_user_action_at ?? now;
    const sri = resolveSourceIdentity(input, now, internal, 'note');
    db.prepare(
      `INSERT INTO ${NOTE_TABLE}
         (id, title, body, created_at, updated_at, last_user_action_at,
          related_contact_ids, related_calendar_event_ids,
          related_mail_thread_ids, related_project_ids,
          source_id, source_record_id, connection_id, source_updated_at,
          last_seen_at, deleted_at, sync_state, conflict_policy,
          source_record_hash, source_extension_blob, source_version_token)
       VALUES
         (@id, @title, @body, @created_at, @updated_at, @last_user_action_at,
          @related_contact_ids, @related_calendar_event_ids,
          @related_mail_thread_ids, @related_project_ids,
          @source_id, @source_record_id, @connection_id, @source_updated_at,
          @last_seen_at, @deleted_at, @sync_state, @conflict_policy,
          @source_record_hash, @source_extension_blob, @source_version_token)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         updated_at = excluded.updated_at,
         last_user_action_at = excluded.last_user_action_at,
         related_contact_ids = excluded.related_contact_ids,
         related_calendar_event_ids = excluded.related_calendar_event_ids,
         related_mail_thread_ids = excluded.related_mail_thread_ids,
         related_project_ids = excluded.related_project_ids,
         source_id = excluded.source_id,
         source_record_id = excluded.source_record_id,
         connection_id = excluded.connection_id,
         source_updated_at = excluded.source_updated_at,
         last_seen_at = excluded.last_seen_at,
         sync_state = excluded.sync_state,
         conflict_policy = excluded.conflict_policy,
         source_record_hash = excluded.source_record_hash,
         source_extension_blob = excluded.source_extension_blob,
         source_version_token = excluded.source_version_token`,
    ).run({
      id,
      title: input.title ?? null,
      body: input.body,
      created_at,
      updated_at,
      last_user_action_at,
      related_contact_ids: stringifyArray(input.related_contact_ids),
      related_calendar_event_ids: stringifyArray(input.related_calendar_event_ids),
      related_mail_thread_ids: stringifyArray(input.related_mail_thread_ids),
      related_project_ids: stringifyArray(input.related_project_ids),
      source_id: sri.source_id,
      source_record_id: sri.source_record_id,
      connection_id: sri.connection_id,
      source_updated_at: sri.source_updated_at,
      last_seen_at: sri.last_seen_at,
      deleted_at: sri.deleted_at,
      sync_state: sri.sync_state,
      conflict_policy: sri.conflict_policy,
      source_record_hash: sri.source_record_hash,
      source_extension_blob: sri.source_extension_blob,
      source_version_token: sri.source_version_token,
    });
    const written = readNote(id);
    if (!written) throw new Error(`writeNote: row ${id} missing post-insert`);
    return written;
  };

  const readNote: WorkEntityStore['readNote'] = (id) => {
    const row = db.prepare(`SELECT * FROM ${NOTE_TABLE} WHERE id = ?`).get(id) as
      | NoteRow
      | undefined;
    return row ? rowToNote(row) : null;
  };

  const listNotes: WorkEntityStore['listNotes'] = (q) => {
    const norm = normalizeListQuery(q);
    const where = buildListWhere(norm);
    const rows = db
      .prepare(
        `SELECT * FROM ${NOTE_TABLE} ${where.sql}
         ORDER BY last_user_action_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...where.params, norm.limit, norm.offset) as NoteRow[];
    return rows.map(rowToNote);
  };

  const findNote: WorkEntityStore['findNote'] = (predicate, q) => {
    for (const n of listNotes(q)) {
      if (predicate(n)) return n;
    }
    return null;
  };

  const deleteNote: WorkEntityStore['deleteNote'] = (id, opts) => {
    if (opts?.tombstone) {
      const now = opts.now ?? Date.now();
      const result = db
        .prepare(
          `UPDATE ${NOTE_TABLE}
           SET sync_state = 'tombstoned', deleted_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, id);
      return result.changes > 0;
    }
    // Hard delete cascades by clearing the ledger first to satisfy FK.
    db.prepare(`DELETE FROM ${NOTE_ACCESS_LEDGER_TABLE} WHERE note_id = ?`).run(id);
    const result = db.prepare(`DELETE FROM ${NOTE_TABLE} WHERE id = ?`).run(id);
    return result.changes > 0;
  };

  const countNotes: WorkEntityStore['countNotes'] = (q) => {
    const norm = normalizeListQuery(q);
    const where = buildListWhere(norm);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${NOTE_TABLE} ${where.sql}`)
      .get(...where.params) as { n: number };
    return row.n;
  };

  const walkByNoteIdStmt = db.prepare(
    `SELECT * FROM ${NOTE_TABLE}
       WHERE id > ?
         AND sync_state IN ('live', 'stale_unreachable')
       ORDER BY id ASC
       LIMIT ?`,
  );
  const walkByNoteId: WorkEntityStore['walkByNoteId'] = (after_id, batch_size) => {
    const safe = Math.max(1, Math.min(batch_size, MAX_LIST_LIMIT));
    const rows = walkByNoteIdStmt.all(after_id, safe) as NoteRow[];
    return rows.map(rowToNote);
  };

  const recordNoteAccess: WorkEntityStore['recordNoteAccess'] = (input) => {
    if (!NOTE_ACCESS_KIND_SET.has(input.access_kind)) {
      throw new WorkEntityValidationError(
        `unknown access_kind '${input.access_kind}'`,
        'access_kind',
      );
    }
    const id = newId();
    db.prepare(
      `INSERT INTO ${NOTE_ACCESS_LEDGER_TABLE}
         (id, note_id, accessed_at, access_kind, access_actor, metadata_blob)
       VALUES
         (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.note_id,
      input.accessed_at,
      input.access_kind,
      input.access_actor ?? null,
      stringifyJsonObject(input.metadata_blob),
    );
    const out: NoteAccessLedgerEntry = {
      id,
      note_id: input.note_id,
      accessed_at: input.accessed_at,
      access_kind: input.access_kind,
    };
    if (input.access_actor !== undefined) out.access_actor = input.access_actor;
    if (input.metadata_blob !== undefined) out.metadata_blob = input.metadata_blob;
    return out;
  };

  const listNoteAccess: WorkEntityStore['listNoteAccess'] = (note_id, opts) => {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
    const rows = db
      .prepare(
        `SELECT * FROM ${NOTE_ACCESS_LEDGER_TABLE}
         WHERE note_id = ? ORDER BY accessed_at DESC LIMIT ?`,
      )
      .all(note_id, limit) as Array<{
        id: string;
        note_id: string;
        accessed_at: number;
        access_kind: NoteAccessKind;
        access_actor: string | null;
        metadata_blob: string | null;
      }>;
    return rows.map((r) => {
      const e: NoteAccessLedgerEntry = {
        id: r.id,
        note_id: r.note_id,
        accessed_at: r.accessed_at,
        access_kind: r.access_kind,
      };
      if (r.access_actor !== null) e.access_actor = r.access_actor;
      const blob = parseJsonObject(r.metadata_blob);
      if (blob) e.metadata_blob = blob;
      return e;
    });
  };

  // ── commitments ─────────────────────────────────────────────────
  const writeCommitment: WorkEntityStore['writeCommitment'] = (input, now = Date.now()) => {
    validateCommitmentInput(input);
    const id = input.id ?? newId();
    const created_at = input.created_at ?? now;
    const updated_at = input.updated_at ?? now;
    const promised_at = input.promised_at ?? now;
    const lifecycle_state = input.lifecycle_state ?? 'pending';
    const due_status =
      input.due_status
      ?? (input.promised_for_at === undefined ? 'no_deadline' : 'not_due');
    const expiry_policy = input.expiry_policy ?? 'escalate_overdue';
    const state_changed_at = input.state_changed_at ?? now;
    const lifecycle_changed_at = input.lifecycle_changed_at ?? now;
    const due_status_changed_at = input.due_status_changed_at ?? now;
    const sri = resolveSourceIdentity(input, now, internal, 'commitment');
    const monetary_amount = input.monetary_value?.amount ?? null;
    const monetary_currency = input.monetary_value?.currency ?? null;
    db.prepare(
      `INSERT INTO ${COMMITMENT_TABLE}
         (id, direction, statement, promised_at, promised_for_at,
          lifecycle_state, due_status, expiry_policy,
          state_changed_at, lifecycle_changed_at, due_status_changed_at,
          derivation, derivation_confidence,
          monetary_amount, monetary_currency,
          counterparty_contact_id, derived_from_mail_thread_id,
          derived_from_meeting_id, blocks_task_ids, blocks_project_ids,
          evidence_blob, created_at, updated_at,
          source_id, source_record_id, connection_id, source_updated_at,
          last_seen_at, deleted_at, sync_state, conflict_policy,
          source_record_hash, source_extension_blob, source_version_token)
       VALUES
         (@id, @direction, @statement, @promised_at, @promised_for_at,
          @lifecycle_state, @due_status, @expiry_policy,
          @state_changed_at, @lifecycle_changed_at, @due_status_changed_at,
          @derivation, @derivation_confidence,
          @monetary_amount, @monetary_currency,
          @counterparty_contact_id, @derived_from_mail_thread_id,
          @derived_from_meeting_id, @blocks_task_ids, @blocks_project_ids,
          @evidence_blob, @created_at, @updated_at,
          @source_id, @source_record_id, @connection_id, @source_updated_at,
          @last_seen_at, @deleted_at, @sync_state, @conflict_policy,
          @source_record_hash, @source_extension_blob, @source_version_token)
       ON CONFLICT(id) DO UPDATE SET
         direction = excluded.direction,
         statement = excluded.statement,
         promised_at = excluded.promised_at,
         promised_for_at = excluded.promised_for_at,
         lifecycle_state = excluded.lifecycle_state,
         due_status = excluded.due_status,
         expiry_policy = excluded.expiry_policy,
         state_changed_at = excluded.state_changed_at,
         lifecycle_changed_at = excluded.lifecycle_changed_at,
         due_status_changed_at = excluded.due_status_changed_at,
         derivation = excluded.derivation,
         derivation_confidence = excluded.derivation_confidence,
         monetary_amount = excluded.monetary_amount,
         monetary_currency = excluded.monetary_currency,
         counterparty_contact_id = excluded.counterparty_contact_id,
         derived_from_mail_thread_id = excluded.derived_from_mail_thread_id,
         derived_from_meeting_id = excluded.derived_from_meeting_id,
         blocks_task_ids = excluded.blocks_task_ids,
         blocks_project_ids = excluded.blocks_project_ids,
         evidence_blob = COALESCE(evidence_blob, excluded.evidence_blob),
         updated_at = excluded.updated_at,
         source_id = excluded.source_id,
         source_record_id = excluded.source_record_id,
         connection_id = excluded.connection_id,
         source_updated_at = excluded.source_updated_at,
         last_seen_at = excluded.last_seen_at,
         sync_state = excluded.sync_state,
         conflict_policy = excluded.conflict_policy,
         source_record_hash = excluded.source_record_hash,
         source_extension_blob = excluded.source_extension_blob,
         source_version_token = excluded.source_version_token`,
    ).run({
      id,
      direction: input.direction,
      statement: input.statement,
      promised_at,
      promised_for_at: input.promised_for_at ?? null,
      lifecycle_state,
      due_status,
      expiry_policy,
      state_changed_at,
      lifecycle_changed_at,
      due_status_changed_at,
      derivation: input.derivation,
      derivation_confidence: input.derivation_confidence ?? null,
      monetary_amount,
      monetary_currency,
      counterparty_contact_id: input.counterparty_contact_id ?? null,
      derived_from_mail_thread_id: input.derived_from_mail_thread_id ?? null,
      derived_from_meeting_id: input.derived_from_meeting_id ?? null,
      blocks_task_ids: stringifyArray(input.blocks_task_ids),
      blocks_project_ids: stringifyArray(input.blocks_project_ids),
      // Evidence is IMMUTABLE once written (invariant 2) — the upsert's
      // COALESCE is FIRST-WRITE-WINS (stored blob outranks excluded):
      // an update that doesn't carry evidence keeps it, and an update
      // that DOES carry a different blob is silently ignored (codex
      // LOW — a backfill/import re-write must never replace the
      // original as-was capture). There is no clear-evidence write.
      evidence_blob:
        input.evidence_blob !== undefined ? JSON.stringify(input.evidence_blob) : null,
      created_at,
      updated_at,
      source_id: sri.source_id,
      source_record_id: sri.source_record_id,
      connection_id: sri.connection_id,
      source_updated_at: sri.source_updated_at,
      last_seen_at: sri.last_seen_at,
      deleted_at: sri.deleted_at,
      sync_state: sri.sync_state,
      conflict_policy: sri.conflict_policy,
      source_record_hash: sri.source_record_hash,
      source_extension_blob: sri.source_extension_blob,
      source_version_token: sri.source_version_token,
    });
    const written = readCommitment(id);
    if (!written) throw new Error(`writeCommitment: row ${id} missing post-insert`);
    return written;
  };

  const readCommitment: WorkEntityStore['readCommitment'] = (id) => {
    const row = db.prepare(`SELECT * FROM ${COMMITMENT_TABLE} WHERE id = ?`).get(id) as
      | CommitmentRow
      | undefined;
    return row ? rowToCommitment(row) : null;
  };

  const listCommitments: WorkEntityStore['listCommitments'] = (q) => {
    const norm = normalizeListQuery(q);
    const where = buildListWhere(norm);
    const rows = db
      .prepare(
        `SELECT * FROM ${COMMITMENT_TABLE} ${where.sql}
         ORDER BY state_changed_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...where.params, norm.limit, norm.offset) as CommitmentRow[];
    return rows.map(rowToCommitment);
  };

  const findCommitment: WorkEntityStore['findCommitment'] = (predicate, q) => {
    for (const c of listCommitments(q)) {
      if (predicate(c)) return c;
    }
    return null;
  };

  const deleteCommitment: WorkEntityStore['deleteCommitment'] = (id, opts) => {
    if (opts?.tombstone) {
      const now = opts.now ?? Date.now();
      const result = db
        .prepare(
          `UPDATE ${COMMITMENT_TABLE}
           SET sync_state = 'tombstoned', deleted_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, id);
      return result.changes > 0;
    }
    const result = db.prepare(`DELETE FROM ${COMMITMENT_TABLE} WHERE id = ?`).run(id);
    return result.changes > 0;
  };

  const countCommitments: WorkEntityStore['countCommitments'] = (q) => {
    const norm = normalizeListQuery(q);
    const where = buildListWhere(norm);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${COMMITMENT_TABLE} ${where.sql}`)
      .get(...where.params) as { n: number };
    return row.n;
  };

  // ── bookings (D-210) ────────────────────────────────────────────
  const writeBooking: WorkEntityStore['writeBooking'] = (input, now = Date.now()) => {
    validateBookingInput(input);
    const id = input.id ?? newId();
    const created_at = input.created_at ?? now;
    const updated_at = input.updated_at ?? now;
    // ⚠ NOT BOOKING_LIFECYCLE_STATES[0] — see the enum's own comment.
    const lifecycle_state = input.lifecycle_state ?? BOOKING_DEFAULT_LIFECYCLE_STATE;
    const state_changed_at = input.state_changed_at ?? now;
    const sri = resolveSourceIdentity(input, now, internal, 'booking');
    const monetary_amount = input.monetary_value?.amount ?? null;
    const monetary_currency = input.monetary_value?.currency ?? null;
    // D-210 A.2 — the slot is both-or-neither. Throwing beats letting the
    // table CHECK do it: this raises at the public store boundary with the
    // field names in the message, and an ALTERed dev table has no CHECK to
    // fall back on, so a half-supplied pair would otherwise persist there
    // and nowhere else.
    const slotStart = input.slot_start_at ?? null;
    const slotEnd = input.slot_end_at ?? null;
    if ((slotStart === null) !== (slotEnd === null)) {
      throw new Error(
        'writeBooking: slot_start_at and slot_end_at must be supplied together (a half-populated slot is a corrupt time, not a partly known one)',
      );
    }
    if (slotStart !== null && slotEnd !== null && slotEnd <= slotStart) {
      throw new Error('writeBooking: slot_end_at must be after slot_start_at');
    }
    db.prepare(
      `INSERT INTO ${BOOKING_TABLE}
         (id, title, lifecycle_state, state_changed_at,
          created_at, updated_at, slot_start_at, slot_end_at,
          monetary_amount, monetary_currency, counterparty_contact_id,
          reception_record_id,
          source_id, source_record_id, connection_id, source_updated_at,
          last_seen_at, deleted_at, sync_state, conflict_policy,
          source_record_hash, source_extension_blob, source_version_token)
       VALUES
         (@id, @title, @lifecycle_state, @state_changed_at,
          @created_at, @updated_at, @slot_start_at, @slot_end_at,
          @monetary_amount, @monetary_currency, @counterparty_contact_id,
          @reception_record_id,
          @source_id, @source_record_id, @connection_id, @source_updated_at,
          @last_seen_at, @deleted_at, @sync_state, @conflict_policy,
          @source_record_hash, @source_extension_blob, @source_version_token)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         lifecycle_state = excluded.lifecycle_state,
         state_changed_at = excluded.state_changed_at,
         slot_start_at = excluded.slot_start_at,
         slot_end_at = excluded.slot_end_at,
         monetary_amount = excluded.monetary_amount,
         monetary_currency = excluded.monetary_currency,
         counterparty_contact_id = excluded.counterparty_contact_id,
         -- FIRST-WRITE-WINS (stored value outranks excluded), the
         -- evidence_blob precedent. The dispatcher happens to carry the old
         -- value forward, but the store is public: a bare upsert naming a
         -- different reception_record_id would silently REWRITE which
         -- visitor request this booking came from. Provenance that lies is
         -- worse than absent, so the column is write-once HERE, not merely by
         -- convention in one caller. (No backticks: inside a template literal.)
         reception_record_id = COALESCE(reception_record_id, excluded.reception_record_id),
         updated_at = excluded.updated_at,
         source_id = excluded.source_id,
         source_record_id = excluded.source_record_id,
         connection_id = excluded.connection_id,
         source_updated_at = excluded.source_updated_at,
         last_seen_at = excluded.last_seen_at,
         sync_state = excluded.sync_state,
         conflict_policy = excluded.conflict_policy,
         source_record_hash = excluded.source_record_hash,
         source_extension_blob = excluded.source_extension_blob,
         source_version_token = excluded.source_version_token`,
    ).run({
      id,
      title: input.title,
      lifecycle_state,
      state_changed_at,
      created_at,
      updated_at,
      slot_start_at: slotStart,
      slot_end_at: slotEnd,
      monetary_amount,
      monetary_currency,
      counterparty_contact_id: input.counterparty_contact_id ?? null,
      reception_record_id: input.reception_record_id ?? null,
      source_id: sri.source_id,
      source_record_id: sri.source_record_id,
      connection_id: sri.connection_id,
      source_updated_at: sri.source_updated_at,
      last_seen_at: sri.last_seen_at,
      deleted_at: sri.deleted_at,
      sync_state: sri.sync_state,
      conflict_policy: sri.conflict_policy,
      source_record_hash: sri.source_record_hash,
      source_extension_blob: sri.source_extension_blob,
      source_version_token: sri.source_version_token,
    });
    const written = readBooking(id);
    if (!written) throw new Error(`writeBooking: row ${id} missing post-insert`);
    return written;
  };

  const readBooking: WorkEntityStore['readBooking'] = (id) => {
    const row = db.prepare(`SELECT * FROM ${BOOKING_TABLE} WHERE id = ?`).get(id) as
      | BookingRow
      | undefined;
    return row ? rowToBooking(row) : null;
  };

  const listBookings: WorkEntityStore['listBookings'] = (q) => {
    const norm = normalizeListQuery(q);
    const where = buildListWhere(norm, true);
    const rows = db
      .prepare(
        // `id DESC` is a TIEBREAK, not decoration: paging with LIMIT/OFFSET over
        // a non-total order lets same-millisecond rows (seeded / imported in one
        // batch) duplicate or skip across pages. `getBookingHistory` and the
        // client-side sort both already tiebreak; this was the odd one out.
        `SELECT * FROM ${BOOKING_TABLE} ${where.sql}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...where.params, norm.limit, norm.offset) as BookingRow[];
    return rows.map(rowToBooking);
  };

  const findBooking: WorkEntityStore['findBooking'] = (predicate, q) => {
    for (const b of listBookings(q)) {
      if (predicate(b)) return b;
    }
    return null;
  };

  const deleteBooking: WorkEntityStore['deleteBooking'] = (id, opts) => {
    if (opts?.tombstone) {
      const now = opts.now ?? Date.now();
      const result = db
        .prepare(
          `UPDATE ${BOOKING_TABLE}
           SET sync_state = 'tombstoned', deleted_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, id);
      return result.changes > 0;
    }
    const result = db.prepare(`DELETE FROM ${BOOKING_TABLE} WHERE id = ?`).run(id);
    return result.changes > 0;
  };

  const countBookings: WorkEntityStore['countBookings'] = (q) => {
    const norm = normalizeListQuery(q);
    const where = buildListWhere(norm, true);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${BOOKING_TABLE} ${where.sql}`)
      .get(...where.params) as { n: number };
    return row.n;
  };

  const getBookingHistory: WorkEntityStore['getBookingHistory'] = (input) => {
    if (
      typeof input.counterparty_contact_id !== 'string'
      || input.counterparty_contact_id.trim().length === 0
      || input.counterparty_contact_id.length > 256
    ) {
      throw new WorkEntityValidationError(
        'counterparty_contact_id must be a non-empty string up to 256 characters',
        'counterparty_contact_id',
      );
    }
    if (
      input.exclude_booking_id !== undefined
      && (typeof input.exclude_booking_id !== 'string' || input.exclude_booking_id.length === 0)
    ) {
      throw new WorkEntityValidationError(
        'exclude_booking_id must be a non-empty string when supplied',
        'exclude_booking_id',
      );
    }
    if (
      input.limit !== undefined
      && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)
    ) {
      throw new WorkEntityValidationError(
        'limit must be an integer between 1 and 50',
        'limit',
      );
    }
    const limit = input.limit ?? 10;
    const extra = input.exclude_booking_id !== undefined ? ' AND id <> ?' : '';
    const params = [
      input.counterparty_contact_id,
      ...(input.exclude_booking_id !== undefined ? [input.exclude_booking_id] : []),
    ];
    // History is an owner-side business lookup, not a live Source browse.
    // Keep terminal rows even if their import Source is later disabled or
    // unreachable; only explicit deletion removes a historical fact.
    const where = `WHERE deleted_at IS NULL
       AND lifecycle_state IN ('completed', 'no_show')
       AND counterparty_contact_id = ?${extra}`;
    const rows = db.prepare(
      `SELECT * FROM ${BOOKING_TABLE} ${where}
       ORDER BY state_changed_at DESC, id DESC LIMIT ?`,
    ).all(...params, limit) as BookingRow[];
    const count = db.prepare(
      `SELECT COUNT(*) AS n FROM ${BOOKING_TABLE} ${where}`,
    ).get(...params) as { n: number };
    return {
      counterparty_contact_id: input.counterparty_contact_id,
      total: count.n,
      entries: rows.map((row) => ({
        id: row.id,
        title: row.title,
        // The SQL closed-list makes this narrowing true at the same boundary.
        lifecycle_state: row.lifecycle_state as 'completed' | 'no_show',
        created_at: row.created_at,
        state_changed_at: row.state_changed_at,
        ...(row.slot_start_at !== null && row.slot_end_at !== null
          ? { slot_start_at: row.slot_start_at, slot_end_at: row.slot_end_at }
          : {}),
      })),
    };
  };

  // ── projects ────────────────────────────────────────────────────
  const writeProject: WorkEntityStore['writeProject'] = (input, now = Date.now()) => {
    validateProjectInput(input);
    const id = input.id ?? newId();
    const created_at = input.created_at ?? now;
    const updated_at = input.updated_at ?? now;
    const last_activity_at = input.last_activity_at ?? now;
    if (input.parent_project_id) {
      checkProjectHierarchyDepth(db, input.parent_project_id, id);
    }
    const sri = resolveSourceIdentity(input, now, internal, 'project');
    db.prepare(
      `INSERT INTO ${PROJECT_TABLE}
         (id, title, description, state, created_at, updated_at,
          target_completion_at, last_activity_at, related_contact_ids,
          parent_project_id,
          source_id, source_record_id, connection_id, source_updated_at,
          last_seen_at, deleted_at, sync_state, conflict_policy,
          source_record_hash, source_extension_blob, source_version_token)
       VALUES
         (@id, @title, @description, @state, @created_at, @updated_at,
          @target_completion_at, @last_activity_at, @related_contact_ids,
          @parent_project_id,
          @source_id, @source_record_id, @connection_id, @source_updated_at,
          @last_seen_at, @deleted_at, @sync_state, @conflict_policy,
          @source_record_hash, @source_extension_blob, @source_version_token)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         state = excluded.state,
         updated_at = excluded.updated_at,
         target_completion_at = excluded.target_completion_at,
         last_activity_at = excluded.last_activity_at,
         related_contact_ids = excluded.related_contact_ids,
         parent_project_id = excluded.parent_project_id,
         source_id = excluded.source_id,
         source_record_id = excluded.source_record_id,
         connection_id = excluded.connection_id,
         source_updated_at = excluded.source_updated_at,
         last_seen_at = excluded.last_seen_at,
         deleted_at = excluded.deleted_at,
         sync_state = excluded.sync_state,
         conflict_policy = excluded.conflict_policy,
         source_record_hash = excluded.source_record_hash,
         source_extension_blob = excluded.source_extension_blob,
         source_version_token = excluded.source_version_token`,
    ).run({
      id,
      title: input.title,
      description: input.description ?? null,
      state: input.state ?? 'active',
      created_at,
      updated_at,
      target_completion_at: input.target_completion_at ?? null,
      last_activity_at,
      related_contact_ids: stringifyArray(input.related_contact_ids),
      parent_project_id: input.parent_project_id ?? null,
      source_id: sri.source_id,
      source_record_id: sri.source_record_id,
      connection_id: sri.connection_id,
      source_updated_at: sri.source_updated_at,
      last_seen_at: sri.last_seen_at,
      deleted_at: sri.deleted_at,
      sync_state: sri.sync_state,
      conflict_policy: sri.conflict_policy,
      source_record_hash: sri.source_record_hash,
      source_extension_blob: sri.source_extension_blob,
      source_version_token: sri.source_version_token,
    });
    const written = readProject(id);
    if (!written) throw new Error(`writeProject: row ${id} missing post-insert`);
    return written;
  };

  const readProject: WorkEntityStore['readProject'] = (id) => {
    const row = db.prepare(`SELECT * FROM ${PROJECT_TABLE} WHERE id = ?`).get(id) as
      | ProjectRow
      | undefined;
    return row ? rowToProject(row) : null;
  };

  const listProjects: WorkEntityStore['listProjects'] = (q) => {
    const norm = normalizeListQuery(q);
    const where = buildListWhere(norm, false, true);
    const rows = db
      .prepare(
        `SELECT * FROM ${PROJECT_TABLE} ${where.sql}
         ORDER BY last_activity_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...where.params, norm.limit, norm.offset) as ProjectRow[];
    return rows.map(rowToProject);
  };

  const findProject: WorkEntityStore['findProject'] = (predicate, q) => {
    for (const p of listProjects(q)) {
      if (predicate(p)) return p;
    }
    return null;
  };

  const deleteProject: WorkEntityStore['deleteProject'] = (id, opts) => {
    if (opts?.tombstone) {
      const now = opts.now ?? Date.now();
      const result = db
        .prepare(
          `UPDATE ${PROJECT_TABLE}
           SET sync_state = 'tombstoned', deleted_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, id);
      return result.changes > 0;
    }
    const result = db.prepare(`DELETE FROM ${PROJECT_TABLE} WHERE id = ?`).run(id);
    return result.changes > 0;
  };

  const countProjects: WorkEntityStore['countProjects'] = (q) => {
    const norm = normalizeListQuery(q);
    const where = buildListWhere(norm, false, true);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${PROJECT_TABLE} ${where.sql}`)
      .get(...where.params) as { n: number };
    return row.n;
  };

  const walkByProjectIdStmt = db.prepare(
    `SELECT * FROM ${PROJECT_TABLE}
       WHERE id > ?
         AND sync_state IN ('live', 'stale_unreachable')
       ORDER BY id ASC
       LIMIT ?`,
  );
  const walkByProjectId: WorkEntityStore['walkByProjectId'] = (after_id, batch_size) => {
    const safe = Math.max(1, Math.min(batch_size, MAX_LIST_LIMIT));
    const rows = walkByProjectIdStmt.all(after_id, safe) as ProjectRow[];
    return rows.map(rowToProject);
  };

  // ── polymorphic ─────────────────────────────────────────────────
  const readByKind: WorkEntityStore['readByKind'] = (kind, id) => {
    if (!WORK_ENTITY_KIND_SET.has(kind)) return null;
    switch (kind) {
      case 'task': {
        const t = readTask(id);
        return t ? { _kind: 'task', ...t } : null;
      }
      case 'note': {
        const n = readNote(id);
        return n ? { _kind: 'note', ...n } : null;
      }
      case 'commitment': {
        const c = readCommitment(id);
        return c ? { _kind: 'commitment', ...c } : null;
      }
      case 'project': {
        const p = readProject(id);
        return p ? { _kind: 'project', ...p } : null;
      }
      case 'booking': {
        const b = readBooking(id);
        return b ? { _kind: 'booking', ...b } : null;
      }
    }
  };

  const readBySourceIdentity: WorkEntityStore['readBySourceIdentity'] = (
    kind,
    source_id,
    source_record_id,
  ) => {
    if (!WORK_ENTITY_KIND_SET.has(kind)) return null;
    const row = db
      .prepare(`SELECT id FROM ${TABLE_FOR_KIND[kind]}
        WHERE source_id = ? AND source_record_id = ?`)
      .get(source_id, source_record_id) as { id: string } | undefined;
    return row === undefined ? null : readByKind(kind, row.id);
  };

  const countByKind: WorkEntityStore['countByKind'] = (kind, query) => {
    switch (kind) {
      case 'task':
        return countTasks(query);
      case 'note':
        return countNotes(query);
      case 'commitment':
        return countCommitments(query);
      case 'project':
        return countProjects(query);
      case 'booking':
        return countBookings(query);
    }
  };

  const listByKind: WorkEntityStore['listByKind'] = (kind, query) => {
    if (!WORK_ENTITY_KIND_SET.has(kind)) {
      throw new WorkEntityValidationError(`unknown kind '${kind}'`, 'kind');
    }
    switch (kind) {
      case 'task':
        return listTasks(query).map((t) => ({ _kind: 'task' as const, ...t }));
      case 'note':
        return listNotes(query).map((n) => ({ _kind: 'note' as const, ...n }));
      case 'commitment':
        return listCommitments(query).map((c) => ({ _kind: 'commitment' as const, ...c }));
      case 'project':
        return listProjects(query).map((p) => ({ _kind: 'project' as const, ...p }));
      case 'booking':
        return listBookings(query).map((b) => ({ _kind: 'booking' as const, ...b }));
    }
  };

  // ── dirty-write state (D-192 P4) — dedicated UPDATE channel, never
  //    part of the full-row upsert column set (see the interface doc).
  const stagePendingWrite: WorkEntityStore['stagePendingWrite'] = (kind, id, pending) => {
    if (!WORK_ENTITY_KIND_SET.has(kind)) {
      throw new WorkEntityValidationError(`unknown kind '${kind}'`, 'kind');
    }
    const res = db
      .prepare(`UPDATE ${TABLE_FOR_KIND[kind]} SET pending_write_blob = ? WHERE id = ?`)
      .run(JSON.stringify(pending), id);
    return res.changes > 0;
  };

  const clearPendingWrite: WorkEntityStore['clearPendingWrite'] = (kind, id) => {
    if (!WORK_ENTITY_KIND_SET.has(kind)) {
      throw new WorkEntityValidationError(`unknown kind '${kind}'`, 'kind');
    }
    const res = db
      .prepare(
        `UPDATE ${TABLE_FOR_KIND[kind]} SET pending_write_blob = NULL
          WHERE id = ? AND pending_write_blob IS NOT NULL`,
      )
      .run(id);
    return res.changes > 0;
  };

  return {
    summarizeContactRelationships,
    writeTask,
    ensureTask,
    readTask,
    listTasks,
    findTask,
    deleteTask,
    countTasks,
    walkByTaskId,
    findCrossSourceTaskCandidates,
    writeNote,
    readNote,
    listNotes,
    findNote,
    deleteNote,
    countNotes,
    walkByNoteId,
    recordNoteAccess,
    listNoteAccess,
    writeCommitment,
    readCommitment,
    listCommitments,
    findCommitment,
    deleteCommitment,
    countCommitments,
    writeBooking,
    readBooking,
    listBookings,
    findBooking,
    deleteBooking,
    countBookings,
    getBookingHistory,
    writeProject,
    readProject,
    listProjects,
    findProject,
    deleteProject,
    countProjects,
    walkByProjectId,
    registerSource,
    unregisterSource,
    getSource,
    listSources,
    setSourceEnabled,
    setSourceMcpExposed,
    getDefaultSource,
    setDefaultSource,
    clearDefaultSource,
    readByKind,
    readBySourceIdentity,
    countByKind,
    listByKind,
    listRecordIdentitiesForSource,
    deleteRecordsForSource,
    countRecordsForSource,
    stagePendingWrite,
    clearPendingWrite,
  };
};

// ────────────────────────────────────────────────────────────────
// Module-level exports — referenced by tests + downstream housekeeping
// ────────────────────────────────────────────────────────────────

export {
  WORK_ENTITY_KINDS,
  TABLE_FOR_KIND,
};
export const ALL_SYNC_STATES = SYNC_STATES;
