/**
 * Intake-form responses as canonical owner data — the generic DESTINATION.
 *
 * ⚠ This header used to say *"this table owns the immutable result of an owner
 * acceptance"*. Both halves were wrong by the time anyone read it: D-210 WS2
 * moved the write to SUBMIT time (the public visitor POST handler), and A.8
 * slice 2 makes the record MUTABLE. That stale sentence was cited once as proof
 * of post-approval semantics and produced a wrong conclusion, so it is
 * corrected rather than left standing. ⇒ [[feedback_declared_is_not_backed]]
 *
 * What is true now: this store is still deliberately separate from the
 * Reception inbox queue — the queue owns unreviewed anonymous input. This table
 * owns the owner's WORKING record of a submission: free-form answers plus a
 * lifecycle the owner advances (`received` → `in_review` → `accepted` /
 * `declined` / `no_show`).
 *
 * ⛔ It is NOT the evidence. The sealed, never-edited record of what a visitor
 * actually submitted is `reception_form_submission`, written first and kept
 * even for spam. Editing a row here does not rewrite history, because the
 * history is not here — that separation is what makes mutability safe.
 *
 * Values are ordinary JSON text because the enclosing per-pair SQLite database
 * is already encrypted. Access control and public packet redaction remain
 * responsibilities of their respective read surfaces.
 */

import type Database from 'better-sqlite3';
import type {
  AcceptFormResponseInput,
  AcceptFormResponseResult,
  FormResponse,
  FormResponseLifecycleState,
  FormResponseListQuery,
  FormResponseVisitor,
} from '@recued/contracts';
import {
  FORM_RESPONSE_DEFAULT_LIFECYCLE_STATE,
  FORM_RESPONSE_LIFECYCLE_STATE_SET,
} from '@recued/contracts';

const TABLE = 'form_response';
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

interface FormResponseRow {
  submission_id: string;
  endpoint_id: string;
  form_definition_id: string;
  definition_snapshot_blob: string;
  values_blob: string;
  visitor_blob: string;
  submitted_at: number;
  accepted_at: number;
  origin_actor: 'anonymous';
  origin_surface: 'system';
  metadata_blob: string;
  lifecycle_state: FormResponseLifecycleState;
  state_changed_at: number;
}

/** The columns `listSummaries` reads — deliberately without the two large
 *  blobs (`values_blob`, `definition_snapshot_blob`). */
interface FormResponseSummaryRow {
  submission_id: string;
  endpoint_id: string;
  form_definition_id: string;
  visitor_blob: string;
  submitted_at: number;
  accepted_at: number;
  metadata_blob: string;
}

/** Small per-row projection for the owner Data browser. Full answer values and
 *  the frozen definition are fetched only when a row is opened (`findById`), so
 *  opening the collection does not decode every visitor's complete submission
 *  (spec §6.1). `metadata` is retained because the list label reads
 *  `metadata.template_ref`. */
export interface FormResponseListSummary {
  readonly submission_id: string;
  readonly endpoint_id: string;
  readonly form_definition_id: string;
  readonly visitor: FormResponseVisitor;
  readonly submitted_at: number;
  readonly accepted_at: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export class FormResponseValidationError extends Error {
  readonly field: string;

  constructor(message: string, field: string) {
    super(message);
    this.name = 'FormResponseValidationError';
    this.field = field;
  }
}

export class FormResponseConflictError extends Error {
  readonly submission_id: string;

  constructor(submission_id: string) {
    super(
      `form response '${submission_id}' already exists with different immutable content`,
    );
    this.name = 'FormResponseConflictError';
    this.submission_id = submission_id;
  }
}

export interface FormResponseStore {
  /**
   * Promote one owner-approved submission. Repeating the exact acceptance is
   * idempotent; the first acceptance timestamp wins on a retry, while
   * attempting to reuse the submission id for different source content fails
   * closed.
   */
  accept(input: AcceptFormResponseInput): AcceptFormResponseResult;
  findById(submission_id: string): FormResponse | null;
  list(query?: FormResponseListQuery): readonly FormResponse[];
  /** Like {@link list} but returns the small Data-browser projection without
   *  decoding the frozen definition or full answer values of every row. */
  listSummaries(query?: FormResponseListQuery): readonly FormResponseListSummary[];
  /**
   * D-210 A.8 slice 2 — advance the owner-authored lifecycle.
   *
   * ⛔ Deliberately NARROW: this is the only mutation, and it touches only
   * `lifecycle_state`. The visitor-authored columns (`values_blob`,
   * `definition_snapshot_blob`, `visitor_blob`, `submitted_at`) are NOT
   * writable here. A.4 does say the destination is editable, but answer-editing
   * is a separate capability with its own provenance question ("whose words are
   * these now?"), and shipping it silently inside a lifecycle setter would
   * answer that question by accident.
   *
   * Returns `null` when the row does not exist — the caller decides whether a
   * missing row is an error, because the rpc and the recipe path disagree.
   */
  setLifecycleState(
    submission_id: string,
    lifecycle_state: FormResponseLifecycleState,
    now: number,
  ): FormResponse | null;
}

export const ensureFormResponseSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      submission_id              TEXT PRIMARY KEY,
      endpoint_id                TEXT NOT NULL,
      form_definition_id         TEXT NOT NULL,
      definition_snapshot_blob   TEXT NOT NULL,
      values_blob                TEXT NOT NULL,
      visitor_blob               TEXT NOT NULL,
      submitted_at               INTEGER NOT NULL,
      accepted_at                INTEGER NOT NULL,
      origin_actor               TEXT NOT NULL DEFAULT 'anonymous'
                                 CHECK (origin_actor = 'anonymous'),
      origin_surface             TEXT NOT NULL DEFAULT 'system'
                                 CHECK (origin_surface = 'system'),
      metadata_blob              TEXT NOT NULL,
      -- D-210 A.7.1 — owner-authored lifecycle. NOT under the origin_actor
      -- CHECK above: that constraint describes who authored the ANSWERS
      -- (always the visitor), and it stays 'anonymous' no matter how many
      -- times the owner advances the state.
      lifecycle_state            TEXT NOT NULL DEFAULT '${FORM_RESPONSE_DEFAULT_LIFECYCLE_STATE}',
      state_changed_at           INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_form_response_accepted
      ON ${TABLE} (accepted_at DESC, submission_id DESC);
    CREATE INDEX IF NOT EXISTS idx_form_response_endpoint
      ON ${TABLE} (endpoint_id, accepted_at DESC, submission_id DESC);
    CREATE INDEX IF NOT EXISTS idx_form_response_definition
      ON ${TABLE} (form_definition_id, accepted_at DESC, submission_id DESC);
  `);
  // ⚠ The lifecycle index is created AFTER the ALTERs below, never here. On a
  // table that predates slice 2 the column does not exist yet, and
  // `CREATE INDEX IF NOT EXISTS` still resolves its column list — so indexing
  // here throws "no such column" on exactly the upgrade path this guard exists
  // to serve.

  // A table created before A.8 slice 2 has neither column. `CREATE TABLE IF
  // NOT EXISTS` silently no-ops on it, so guard each ADD with a PRAGMA check —
  // the same shape `annotation-store.ts` uses for its origin_* backfill.
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${TABLE})`).all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('lifecycle_state')) {
    db.exec(
      `ALTER TABLE ${TABLE} ADD COLUMN lifecycle_state TEXT NOT NULL `
        + `DEFAULT '${FORM_RESPONSE_DEFAULT_LIFECYCLE_STATE}'`,
    );
  }
  if (!columns.has('state_changed_at')) {
    // 0, not "now": an existing row's state has never CHANGED, and stamping
    // the migration instant would claim every historical response transitioned
    // the day we deployed.
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN state_changed_at INTEGER NOT NULL DEFAULT 0`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_form_response_lifecycle
      ON ${TABLE} (endpoint_id, lifecycle_state, accepted_at DESC);
  `);
};

const requireId = (value: string, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FormResponseValidationError(`${field} must be a non-empty string`, field);
  }
  return value;
};

const requireTimestamp = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new FormResponseValidationError(
      `${field} must be a non-negative integer unix-ms timestamp`,
      field,
    );
  }
  return value;
};

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
};

const encodeObject = (value: unknown, field: string): string => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FormResponseValidationError(`${field} must be a JSON object`, field);
  }
  try {
    // Normalize through JSON first so Dates, undefined object properties, and
    // other JSON-compatible inputs have exactly the representation we persist.
    const raw = JSON.stringify(value);
    const normalized = JSON.parse(raw) as unknown;
    if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
      throw new Error('not an object');
    }
    return stableJson(normalized);
  } catch (error) {
    if (error instanceof FormResponseValidationError) throw error;
    throw new FormResponseValidationError(`${field} must be JSON-serializable`, field);
  }
};

const decodeObject = (raw: string): Readonly<Record<string, unknown>> => {
  const value = JSON.parse(raw) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('form response store contains a non-object JSON blob');
  }
  return value as Readonly<Record<string, unknown>>;
};

const encodeVisitor = (visitor: unknown): string => {
  if (visitor !== undefined && visitor !== null && typeof visitor === 'object') {
    const email = (visitor as Record<string, unknown>).email;
    if (email !== undefined && (typeof email !== 'string' || email.trim().length === 0)) {
      throw new FormResponseValidationError(
        'visitor.email must be a non-empty string when present',
        'visitor.email',
      );
    }
  }
  return encodeObject(visitor ?? {}, 'visitor');
};

const rowToResponse = (row: FormResponseRow): FormResponse => ({
  _id: row.submission_id,
  _collection: 'form_response',
  submission_id: row.submission_id,
  endpoint_id: row.endpoint_id,
  form_definition_id: row.form_definition_id,
  definition_snapshot: decodeObject(row.definition_snapshot_blob),
  values: decodeObject(row.values_blob),
  visitor: decodeObject(row.visitor_blob),
  submitted_at: row.submitted_at,
  accepted_at: row.accepted_at,
  origin_actor: row.origin_actor,
  origin_surface: row.origin_surface,
  lifecycle_state: row.lifecycle_state,
  state_changed_at: row.state_changed_at,
  metadata: decodeObject(row.metadata_blob),
});

const rowToSummary = (row: FormResponseSummaryRow): FormResponseListSummary => ({
  submission_id: row.submission_id,
  endpoint_id: row.endpoint_id,
  form_definition_id: row.form_definition_id,
  visitor: decodeObject(row.visitor_blob),
  submitted_at: row.submitted_at,
  accepted_at: row.accepted_at,
  metadata: decodeObject(row.metadata_blob),
});

/** Build the shared `WHERE`/keyset clause + bound params for a list query. The
 *  full-record `list` and the projected `listSummaries` differ only in their
 *  `SELECT`, so the filter, cursor, and validation stay in one place. */
const buildListWhere = (
  query: FormResponseListQuery,
): { whereClause: string; params: Record<string, unknown> } => {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.endpoint_id !== undefined) {
    params.endpoint_id = requireId(query.endpoint_id, 'endpoint_id');
    clauses.push('endpoint_id = @endpoint_id');
  }
  if (query.form_definition_id !== undefined) {
    params.form_definition_id = requireId(
      query.form_definition_id,
      'form_definition_id',
    );
    clauses.push('form_definition_id = @form_definition_id');
  }
  if (query.before !== undefined) {
    if (query.before === null || typeof query.before !== 'object') {
      throw new FormResponseValidationError(
        'before must contain accepted_at and submission_id',
        'before',
      );
    }
    params.before_accepted_at = requireTimestamp(
      query.before.accepted_at,
      'before.accepted_at',
    );
    params.before_submission_id = requireId(
      query.before.submission_id,
      'before.submission_id',
    );
    clauses.push(
      '(accepted_at < @before_accepted_at '
      + 'OR (accepted_at = @before_accepted_at '
      + 'AND submission_id < @before_submission_id))',
    );
  }
  return {
    whereClause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
};

const resolveLimit = (limit: number | undefined): number => {
  const resolved = limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_LIST_LIMIT) {
    throw new FormResponseValidationError(
      `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
      'limit',
    );
  }
  return resolved;
};

/** The columns `accept` actually BINDS. Deliberately NOT `FormResponseRow`:
 *  the two lifecycle columns are owner-authored and take their schema defaults
 *  on insert. Typing a write payload as the full read row would imply a
 *  visitor's submission gets to set the owner's state. */
type FormResponseInsert = Omit<FormResponseRow, 'lifecycle_state' | 'state_changed_at'>;

const normalizeInput = (input: AcceptFormResponseInput): FormResponseInsert => {
  const submitted_at = requireTimestamp(input.submitted_at, 'submitted_at');
  const accepted_at = requireTimestamp(input.accepted_at, 'accepted_at');
  if (accepted_at < submitted_at) {
    throw new FormResponseValidationError(
      'accepted_at must be greater than or equal to submitted_at',
      'accepted_at',
    );
  }
  return {
    submission_id: requireId(input.submission_id, 'submission_id'),
    endpoint_id: requireId(input.endpoint_id, 'endpoint_id'),
    form_definition_id: requireId(input.form_definition_id, 'form_definition_id'),
    definition_snapshot_blob: encodeObject(
      input.definition_snapshot,
      'definition_snapshot',
    ),
    values_blob: encodeObject(input.values, 'values'),
    visitor_blob: encodeVisitor(input.visitor),
    submitted_at,
    accepted_at,
    origin_actor: 'anonymous',
    origin_surface: 'system',
    metadata_blob: encodeObject(input.metadata ?? {}, 'metadata'),
  };
};

const immutableRowsMatch = (left: FormResponseInsert, right: FormResponseInsert): boolean =>
  left.submission_id === right.submission_id
  && left.endpoint_id === right.endpoint_id
  && left.form_definition_id === right.form_definition_id
  && left.definition_snapshot_blob === right.definition_snapshot_blob
  && left.values_blob === right.values_blob
  && left.visitor_blob === right.visitor_blob
  && left.submitted_at === right.submitted_at
  && left.origin_actor === right.origin_actor
  && left.origin_surface === right.origin_surface
  && left.metadata_blob === right.metadata_blob;

export const createFormResponseStore = (
  db: Database.Database,
): FormResponseStore => {
  ensureFormResponseSchema(db);

  const insertStmt = db.prepare(`
    INSERT INTO ${TABLE} (
      submission_id, endpoint_id, form_definition_id,
      definition_snapshot_blob, values_blob, visitor_blob,
      submitted_at, accepted_at, origin_actor, origin_surface, metadata_blob
    ) VALUES (
      @submission_id, @endpoint_id, @form_definition_id,
      @definition_snapshot_blob, @values_blob, @visitor_blob,
      @submitted_at, @accepted_at, @origin_actor, @origin_surface, @metadata_blob
    )
    ON CONFLICT(submission_id) DO NOTHING
  `);
  const findStmt = db.prepare(
    `SELECT * FROM ${TABLE} WHERE submission_id = ?`,
  );
  const updateLifecycleStmt = db.prepare(`
    UPDATE ${TABLE}
       SET lifecycle_state  = @lifecycle_state,
           state_changed_at = CASE WHEN lifecycle_state = @lifecycle_state
                                   THEN state_changed_at
                                   ELSE @now END
     WHERE submission_id = @submission_id
  `);

  const findRow = (submission_id: string): FormResponseRow | null =>
    (findStmt.get(submission_id) as FormResponseRow | undefined) ?? null;

  return {
    accept(input) {
      const normalized = normalizeInput(input);
      const result = insertStmt.run(normalized);
      const stored = findRow(normalized.submission_id);
      if (stored === null) {
        throw new Error(
          `FormResponseStore.accept: row '${normalized.submission_id}' missing after insert`,
        );
      }
      if (result.changes === 0 && !immutableRowsMatch(stored, normalized)) {
        throw new FormResponseConflictError(normalized.submission_id);
      }
      return {
        status: result.changes > 0 ? 'created' : 'existing',
        response: rowToResponse(stored),
      };
    },

    findById(submission_id) {
      requireId(submission_id, 'submission_id');
      const row = findRow(submission_id);
      return row === null ? null : rowToResponse(row);
    },

    list(query = {}) {
      const { whereClause, params } = buildListWhere(query);
      params.limit = resolveLimit(query.limit);
      const rows = db.prepare(`
        SELECT * FROM ${TABLE}
        ${whereClause}
        ORDER BY accepted_at DESC, submission_id DESC
        LIMIT @limit
      `).all(params) as FormResponseRow[];
      return rows.map(rowToResponse);
    },

    listSummaries(query = {}) {
      const { whereClause, params } = buildListWhere(query);
      params.limit = resolveLimit(query.limit);
      // Name the columns explicitly — never `SELECT *` — so SQLite does not read
      // (and this store does not decode) the large `values_blob` /
      // `definition_snapshot_blob` for every row just to render a summary list.
      const rows = db.prepare(`
        SELECT submission_id, endpoint_id, form_definition_id,
               visitor_blob, submitted_at, accepted_at, metadata_blob
        FROM ${TABLE}
        ${whereClause}
        ORDER BY accepted_at DESC, submission_id DESC
        LIMIT @limit
      `).all(params) as FormResponseSummaryRow[];
      return rows.map(rowToSummary);
    },

    setLifecycleState(submission_id, lifecycle_state, now) {
      requireId(submission_id, 'submission_id');
      // Validate against the contract SET, not a copied literal list — the
      // vocabulary has exactly one home and this must not drift from it.
      if (!FORM_RESPONSE_LIFECYCLE_STATE_SET.has(lifecycle_state)) {
        throw new FormResponseValidationError(
          `lifecycle_state must be one of ${[...FORM_RESPONSE_LIFECYCLE_STATE_SET].join(', ')}`,
          'lifecycle_state',
        );
      }
      requireTimestamp(now, 'now');
      // `state_changed_at` moves ONLY on a real transition. In a SQLite UPDATE
      // the SET expressions read the row's OLD values, so this compares the
      // stored state against the incoming one: re-applying `no_show` to a row
      // that is already `no_show` is a no-op that must not restamp the clock,
      // or "when did they no-show?" quietly becomes "when was this last
      // touched?" — the same trap booking's `state_changed_at` documents.
      updateLifecycleStmt.run({ submission_id, lifecycle_state, now });
      const row = findRow(submission_id);
      return row === null ? null : rowToResponse(row);
    },
  };
};
