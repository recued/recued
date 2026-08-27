/** D-117 Phase 1 Commit 2 — per-instance calendar warehouse table.
 *
 *  Parallel to `collections/table.ts` (mail / file / webhook) but with
 *  a calendar-specific shape: dedicated hot-field columns (not a JSON
 *  blob), a `record_payload` column carrying the full
 *  `CanonicalEvent` JSON, a `prior_payload` column that rotates one
 *  version back on every overwrite, and an optional `etag` column for
 *  the CalDAV adapter's per-resource validator.
 *
 *  One `CalendarCollectionTable` lives per `(slug)` pair. The factory
 *  creates the data table + FTS5 companion on first call and is
 *  idempotent on subsequent calls with the same slug — same pattern
 *  as `createCollectionTable`.
 *
 *  Body storage mirrors D-106:
 *    description ≤ 64 KB → `body_inline` (TEXT, FTS5-indexed).
 *    description > 64 KB → CAS blob via `blob_hash`; body_inline is
 *                          null and FTS5 skips indexing the
 *                          description text (consistent with mail).
 *
 *  The table owns neither CAS I/O nor the engine's gate — callers
 *  pre-compute `blob_hash` for oversized descriptions and pass the
 *  record ready-to-store. The only invariant this module enforces is
 *  "at most one of body_inline / blob_hash per row" (mutually
 *  exclusive like `CollectionRecord`).
 *
 *  `prior_payload` depth is exactly 1 — not a revision log. First-
 *  ever sync leaves `prior_payload` null. Every subsequent upsert
 *  rotates: `prior ← current; current ← new`. Quota accounting counts
 *  both columns together; retention drops by `modified_at` regardless
 *  of prior payload size.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

import {
  createFtsTable,
  dropFtsTable,
  indexRecord as ftsIndexRecord,
  deleteRecord as ftsDeleteRecord,
} from '@recued/fts';
// One definition of the trailing-`*` prefix convention, shared with the generic
// collection table — see the note on `toFtsMatch`.
import {
  applyRecencyFloor,
  relaxToPresentPrefixTokens,
  toFtsMatch,
} from '../table.js';
import type {
  CalendarRecordHotFields,
  CalendarRecordStat,
  CanonicalEvent,
} from '@recued/contracts';

/** Inline / CAS split threshold for descriptions. Matches mail's
 *  `INLINE_CUTOFF_BYTES`; they are load-bearing together so the
 *  shared gate accounting behaves predictably. */
export const CALENDAR_INLINE_CUTOFF_BYTES = 64 * 1024;

/** Max rows returned by a single list / search. */
export const CALENDAR_MAX_LIST_LIMIT = 500;

/** Default page size when `limit` is omitted. */
const DEFAULT_LIST_LIMIT = 100;

// ────────────────────────────────────────────────────────────────
// SQL identifier helpers
// ────────────────────────────────────────────────────────────────

const slugHash = (slug: string): string =>
  createHash('sha256').update(slug).digest('hex').slice(0, 10);

const IDENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const assertIdent = (name: string): string => {
  if (!IDENT_PATTERN.test(name)) {
    throw new CalendarTableError(`invalid SQL identifier: ${name}`);
  }
  return name;
};

export class CalendarTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarTableError';
  }
}

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

/** Input to `upsert`. Callers hand the table a ready-to-store record:
 *  the canonical event, the body-split decision (body_inline vs
 *  blob_hash), and adapter-specific bookkeeping (etag for caldav).
 *
 *  The table stamps `received_at` (first-insert only) + `modified_at`
 *  from the event's `updated_at`, rotates `prior_payload`, and writes
 *  the hot-field columns from the event fields. */
export interface CalendarUpsertInput {
  event: CanonicalEvent;
  /** Size of the description body in bytes (UTF-8). Used for the
   *  inline-vs-CAS decision; also summed into the row's `size_bytes`
   *  for quota accounting. */
  size_bytes: number;
  /** Inline description when `size_bytes <= CALENDAR_INLINE_CUTOFF_BYTES`.
   *  Mutually exclusive with `blob_hash`. */
  body_inline?: string;
  /** CAS pointer when the description is too large for inline
   *  storage. Caller has already written the body to CAS. */
  blob_hash?: string;
  /** CalDAV ETag from the last REPORT calendar-query. Leave null for
   *  gcal / graph which use a different cursor (stored on
   *  `collection_instances.config.sync_cursor`). */
  etag?: string;
  /** Unix-ms stamp for `received_at` on a first-ever insert. The
   *  column is preserved across replace — only new records pick it
   *  up. Defaults to `Date.now()`. */
  now?: number;
}

/** Snapshot of a calendar warehouse row. Returned from `get`, mapped
 *  from the JSON payload on demand. */
export interface CalendarRowSnapshot {
  /** Stable hash of `(slug, source_id)`. Drives primary-key lookup. */
  record_id: string;
  source_id: string;
  received_at: number;
  modified_at: number;
  size_bytes: number;
  /** Current event payload — JSON-deserialized. */
  event: CanonicalEvent;
  /** Previous event payload (depth=1). `null` on first insert. */
  prior: CanonicalEvent | null;
  /** Inline description body. Null when the description was
   *  externalized to CAS or is empty. */
  body_inline: string | null;
  /** CAS pointer for oversized description bodies. */
  blob_hash: string | null;
  /** CalDAV resource validator. Null for non-CalDAV adapters. */
  etag: string | null;
  hot: CalendarRecordHotFields;
}

/** Result of a delete — returns the removed row's CAS pointer (if
 *  any) so the caller can route into the orphan-CAS sweep, the row's
 *  size so gate accounting stays consistent, and (D-124 Phase 1) a
 *  full prior snapshot so the warehouse-event emitter can attach
 *  `prev` to the `deleted` event for trigger consumers. `prior` is
 *  null when `deleted` is false. */
export interface CalendarDeleteResult {
  deleted: boolean;
  size_bytes: number;
  blob_hash: string | null;
  prior: CalendarRowSnapshot | null;
}

export interface CalendarListQuery {
  /** Lower bound on `start_at` (inclusive, unix-ms). */
  start_since?: number;
  /** Upper bound on `start_at` (exclusive, unix-ms). */
  start_until?: number;
  /** Lower bound on `modified_at` (exclusive, unix-ms). Used by the
   *  `changed_since` watcher mode in Phase 8. */
  modified_since?: number;
  /** Filter to a specific calendar on the account. */
  calendar_id?: string;
  /** Filter on event status. */
  status?: CanonicalEvent['status'];
  /** `'start_at'` (ascending) is the natural order for watcher
   *  look-aheads; `'modified_at'` matches `changed_since`.
   *  `'received_at'` is the warehouse-insertion order. */
  order_by?: 'start_at' | 'modified_at' | 'received_at';
  direction?: 'asc' | 'desc';
  limit?: number;
}

export interface CalendarSearchQuery {
  /** Raw FTS5 MATCH expression. Callers sanitize user input. */
  query: string;
  limit?: number;
}

export interface CalendarSearchMatch {
  record_id: string;
  hot: CalendarRecordHotFields;
  rank: number;
  snippet: string;
}

export interface CalendarCollectionTable {
  /** Insert or replace the row keyed by the event's `source_id`.
   *  Rotates the prior payload before overwriting. Returns the prior
   *  row's snapshot, or `null` on first insert. */
  upsert(input: CalendarUpsertInput): CalendarRowSnapshot | null;
  /** Remove by `source_id`. Returns `{ deleted, size_bytes,
   *  blob_hash }`. */
  delete(source_id: string): CalendarDeleteResult;
  /** Single-row snapshot or null when the source_id is unknown. */
  get(source_id: string): CalendarRowSnapshot | null;
  /** Single-row snapshot by primary-key `record_id` (the `cal:<hash>` id the
   *  generic `collection.get` addresses) or null when unknown — `get` above
   *  keys on the provider `source_id`. */
  getByRecordId(record_id: string): CalendarRowSnapshot | null;
  /** Hot-field-only stat (file-stat precedent): `exists: false` on
   *  missing rows; other columns omitted. */
  stat(source_id: string): CalendarRecordStat;
  /** Filtered hot-field listing. Returns hot fields only — full
   *  payload isn't materialized, so this is cheap for watcher
   *  queries. */
  list(query: CalendarListQuery): CalendarRecordHotFields[];
  /** Same filter shape as `list`, but returns full row snapshots
   *  (current + prior payloads + inline body + etag). The
   *  calendar-watcher handler uses this path so `CalendarWatcherItem`
   *  carries `prior` without a second round-trip per event. */
  listSnapshots(query: CalendarListQuery): CalendarRowSnapshot[];
  /** FTS5 search over summary + description + location. */
  search(query: CalendarSearchQuery): CalendarSearchMatch[];

  /** Metadata-only exact participant aggregate. Matches any supplied canonical
   * or merged email as organizer/attendee, excludes cancelled events, and
   * buckets by whether the event has ended at `as_of`. One event is counted
   * once even when two aliases appear on the same event. */
  summarizeParticipant(
    emails: readonly string[],
    as_of: number,
  ): CalendarParticipantRelationshipCounts;

  /** Sum of `size_bytes` across every row — primes the collection
   *  gate at boot. */
  totalBytes(): number;
  /** Distinct `blob_hash` values across every live row. Consumed by
   *  the orphan-CAS sweep to build its keep-set. */
  referencedBlobHashes(): Set<string>;
  /** Count of rows in the table. Surfaces onto
   *  `CalendarCollectionHealth.event_count`. */
  eventCount(): number;
  /** Events with `start_at` in `[now, now + window_ms)`. Surfaces
   *  onto `CalendarCollectionHealth.upcoming_count_24h` with the
   *  default 24-hour window. */
  upcomingCount(now: number, window_ms: number): number;
  /** Count of non-cancelled events whose interval OVERLAPS
   *  `[window_start, window_end)`.
   *
   *  ⚠ This is NOT `list({ start_since, start_until })`. That filters on
   *  `start_at` alone, so an event running 11:00–15:00 does not match a
   *  12:00–14:00 window even though it plainly collides with it. The
   *  half-open overlap predicate — `start_at < window_end AND end_at >
   *  window_start` — is the only one that answers "is anything happening
   *  then". Counting with the wrong predicate under-reports exactly the
   *  long events most worth knowing about.
   *
   *  `status = 'cancelled'` rows are excluded: a cancelled event occupies
   *  nothing. `tentative` IS counted — it is unresolved, not absent, and the
   *  reader is deciding whether they are free.
   *
   *  Feeds the owner-facing overlap count on the D-157 approval surface
   *  (D-173 D7 — "confirmed at approval"). */
  overlapCount(window_start: number, window_end: number): number;

  /** Drop every row with `modified_at < cutoff`. Returns the deleted
   *  count + freed bytes + orphaned blob hashes so retention can
   *  route into the CAS sweep. Retention is by `modified_at` (not
   *  `received_at`) because calendar events accrete edits — an event
   *  created three years ago but edited last week should be kept. */
  pruneOlderThan(cutoff: number): {
    pruned_count: number;
    bytes_freed: number;
    blob_hashes_freed: string[];
  };

  /** Drop both the data + FTS tables. Used only by tests + uninstall. */
  dropSchema(): void;

  readonly tableName: string;
  readonly ftsName: string;
}

export interface CalendarParticipantRelationshipCounts {
  active_count: number;
  historical_count: number;
  observed_count: number;
}

export interface CreateCalendarTableOptions {
  db: Database.Database;
  /** User-chosen slug. Hashed before concatenation into SQL
   *  identifiers so TOML content can't escape the grammar. */
  slug: string;
  /** Phase B gate hook. Every write / delete / prune reports the
   *  signed byte delta so the collection's gate tracks live
   *  `SUM(size_bytes)` without needing a separate scan. Exceptions
   *  are swallowed — a misbehaving gate never breaks a write. */
  onBytesChanged?: (delta: number) => void;
}

// ────────────────────────────────────────────────────────────────
// Row helpers
// ────────────────────────────────────────────────────────────────

interface Row {
  record_id: string;
  source_id: string;
  received_at: number;
  modified_at: number;
  size_bytes: number;
  calendar_id: string;
  summary: string;
  start_at: number;
  end_at: number;
  status: string;
  organizer: string | null;
  ical_uid: string;
  location: string | null;
  is_all_day: number;
  is_recurring: number;
  body_inline: string | null;
  blob_hash: string | null;
  etag: string | null;
  record_payload: string;
  prior_payload: string | null;
}

const rowHotFields = (row: Row): CalendarRecordHotFields => {
  const hot: CalendarRecordHotFields = {
    calendar_id: row.calendar_id,
    summary: row.summary,
    start_at: row.start_at,
    end_at: row.end_at,
    status: row.status as CanonicalEvent['status'],
    ical_uid: row.ical_uid,
    is_all_day: row.is_all_day === 1,
    is_recurring: row.is_recurring === 1,
  };
  if (row.organizer !== null) hot.organizer = row.organizer;
  if (row.location !== null) hot.location = row.location;
  return hot;
};

const rowToSnapshot = (row: Row): CalendarRowSnapshot => ({
  record_id: row.record_id,
  source_id: row.source_id,
  received_at: row.received_at,
  modified_at: row.modified_at,
  size_bytes: row.size_bytes,
  event: JSON.parse(row.record_payload) as CanonicalEvent,
  prior:
    row.prior_payload === null
      ? null
      : (JSON.parse(row.prior_payload) as CanonicalEvent),
  body_inline: row.body_inline,
  blob_hash: row.blob_hash,
  etag: row.etag,
  hot: rowHotFields(row),
});

const recordIdFor = (slug: string, source_id: string): string =>
  `cal:${createHash('sha256')
    .update(`${slug}\u0000${source_id}`)
    .digest('hex')
    .slice(0, 32)}`;

const ftsTextFor = (event: CanonicalEvent, body_inline: string | null): string => {
  // FTS index is over summary + description + location + attendee /
  // organizer names and emails — so the chat agent's `calendar.search`
  // can find "meetings with <person>" by that person's name or canonical
  // email. When the description spilled to CAS, body_inline is null and
  // we drop it from the index entirely — same rule mail follows for
  // oversized bodies. Callers searching a CAS-stored description must
  // fall back to a linear scan (documented limit).
  const parts = [event.summary ?? ''];
  if (body_inline !== null && body_inline !== '') parts.push(body_inline);
  if (event.location) parts.push(event.location);
  if (event.organizer) {
    if (event.organizer.display_name) parts.push(event.organizer.display_name);
    parts.push(event.organizer.email);
  }
  for (const a of event.attendees ?? []) {
    if (a.display_name) parts.push(a.display_name);
    parts.push(a.email);
  }
  return parts.join('\n');
};

// ────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────

const validateUpsert = (input: CalendarUpsertInput): void => {
  if (typeof input.event.source_id !== 'string' || input.event.source_id === '') {
    throw new CalendarTableError('event.source_id required');
  }
  if (input.body_inline !== undefined && input.blob_hash !== undefined) {
    throw new CalendarTableError(
      'body_inline and blob_hash are mutually exclusive',
    );
  }
  if (input.body_inline !== undefined) {
    const bytes = Buffer.byteLength(input.body_inline, 'utf8');
    if (bytes > CALENDAR_INLINE_CUTOFF_BYTES) {
      throw new CalendarTableError(
        `body_inline exceeds CALENDAR_INLINE_CUTOFF_BYTES (${bytes} > ${CALENDAR_INLINE_CUTOFF_BYTES}); caller must CAS-put first`,
      );
    }
  }
};

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

export const createCalendarTable = (
  opts: CreateCalendarTableOptions,
): CalendarCollectionTable => {
  const { db, slug } = opts;
  const onBytesChanged = opts.onBytesChanged;

  const hash = slugHash(slug);
  const tableName = assertIdent(`collection_calendar_${hash}`);
  const ftsName = assertIdent(`${tableName}_fts`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      record_id       TEXT PRIMARY KEY,
      source_id       TEXT NOT NULL UNIQUE,
      received_at     INTEGER NOT NULL,
      modified_at     INTEGER NOT NULL,
      size_bytes      INTEGER NOT NULL,
      calendar_id     TEXT NOT NULL,
      summary         TEXT NOT NULL,
      start_at        INTEGER NOT NULL,
      end_at          INTEGER NOT NULL,
      status          TEXT NOT NULL,
      organizer       TEXT,
      ical_uid        TEXT NOT NULL,
      location        TEXT,
      is_all_day      INTEGER NOT NULL,
      is_recurring    INTEGER NOT NULL,
      body_inline     TEXT,
      blob_hash       TEXT,
      etag            TEXT,
      record_payload  TEXT NOT NULL,
      prior_payload   TEXT
    );
    -- THE BLOB-GC KEEPSET INDEX. The cascade's blob sweep and archive export
    --   both build a keepset with
    --     SELECT DISTINCT blob_hash ... WHERE blob_hash IS NOT NULL
    --   which planned as a full SCAN plus a TEMP B-TREE for the DISTINCT --
    --   reading every row of the table to find the few that carry a CAS blob.
    --   Measured at 200k rows with 2%% blob-bearing: 3.34ms -> 0.01ms (334x),
    --   identical answer.
    --
    -- PARTIAL, so it holds only the blob-bearing rows -- 4,000 of 200,000 in
    --   that measurement. Only ~2%% of writes touch it, which is what makes a
    --   recurring O(all rows) GC pass into an O(blob rows) one for almost no
    --   write cost. It is also COVERING for this query, so the DISTINCT dedups
    --   over already-sorted index values instead of building a b-tree.
    --
    -- One shape, six call sites (collections, calendar, annotation,
    --   shared_store, cache_entries, and the collection_* walk in
    --   collection-blob-refs.ts). Fixing one would have left the rest scanning.
    CREATE INDEX IF NOT EXISTS idx_${tableName}_blob_hash
      ON ${tableName} (blob_hash) WHERE blob_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_${tableName}_start
      ON ${tableName} (start_at);
    CREATE INDEX IF NOT EXISTS idx_${tableName}_modified
      ON ${tableName} (modified_at);
    CREATE INDEX IF NOT EXISTS idx_${tableName}_uid
      ON ${tableName} (ical_uid);
    CREATE INDEX IF NOT EXISTS idx_${tableName}_calendar
      ON ${tableName} (calendar_id);
  `);
  createFtsTable(db, ftsName);

  const reportDelta = (delta: number): void => {
    if (!onBytesChanged || delta === 0) return;
    try { onBytesChanged(delta); } catch { /* never break writes */ }
  };

  const getByIdStmt = db.prepare(
    `SELECT * FROM ${tableName} WHERE record_id = ?`,
  );
  const getBySourceStmt = db.prepare(
    `SELECT * FROM ${tableName} WHERE source_id = ?`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM ${tableName} WHERE record_id = ?`,
  );
  const upsertStmt = db.prepare(`
    INSERT INTO ${tableName} (
      record_id, source_id, received_at, modified_at, size_bytes,
      calendar_id, summary, start_at, end_at, status,
      organizer, ical_uid, location, is_all_day, is_recurring,
      body_inline, blob_hash, etag,
      record_payload, prior_payload
    ) VALUES (
      @record_id, @source_id, @received_at, @modified_at, @size_bytes,
      @calendar_id, @summary, @start_at, @end_at, @status,
      @organizer, @ical_uid, @location, @is_all_day, @is_recurring,
      @body_inline, @blob_hash, @etag,
      @record_payload, @prior_payload
    )
    ON CONFLICT(record_id) DO UPDATE SET
      modified_at    = excluded.modified_at,
      size_bytes     = excluded.size_bytes,
      calendar_id    = excluded.calendar_id,
      summary        = excluded.summary,
      start_at       = excluded.start_at,
      end_at         = excluded.end_at,
      status         = excluded.status,
      organizer      = excluded.organizer,
      ical_uid       = excluded.ical_uid,
      location       = excluded.location,
      is_all_day     = excluded.is_all_day,
      is_recurring   = excluded.is_recurring,
      body_inline    = excluded.body_inline,
      blob_hash      = excluded.blob_hash,
      etag           = excluded.etag,
      record_payload = excluded.record_payload,
      prior_payload  = excluded.prior_payload
  `);

  const totalBytesStmt = db.prepare(
    `SELECT COALESCE(SUM(size_bytes), 0) AS total FROM ${tableName}`,
  );
  const referencedBlobsStmt = db.prepare(
    `SELECT DISTINCT blob_hash FROM ${tableName} WHERE blob_hash IS NOT NULL`,
  );
  const eventCountStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ${tableName}`,
  );
  const upcomingCountStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ${tableName}
      WHERE start_at >= ? AND start_at < ?`,
  );
  // Half-open interval overlap: [start_at, end_at) ∩ [window_start, window_end)
  // ≠ ∅. Note the asymmetry against `upcomingCountStmt` above — that one keys on
  // `start_at` alone and would miss an event that STRADDLES the window.
  const overlapCountStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ${tableName}
      WHERE start_at < ? AND end_at > ? AND status != 'cancelled'`,
  );
  const summarizeParticipantStmt = db.prepare(
    `SELECT
       SUM(CASE WHEN end_at > ? THEN 1 ELSE 0 END) AS active_count,
       SUM(CASE WHEN end_at <= ? THEN 1 ELSE 0 END) AS historical_count,
       COUNT(*) AS observed_count
     FROM ${tableName}
     WHERE status != 'cancelled'
       AND (
         LOWER(COALESCE(organizer, '')) IN (SELECT value FROM json_each(?))
         OR EXISTS (
           SELECT 1 FROM json_each(${tableName}.record_payload, '$.attendees') AS attendee
            WHERE LOWER(COALESCE(json_extract(attendee.value, '$.email'), ''))
              IN (SELECT value FROM json_each(?))
         )
       )`,
  );

  const upsert = (input: CalendarUpsertInput): CalendarRowSnapshot | null => {
    validateUpsert(input);
    const now = input.now ?? Date.now();
    const event = input.event;
    const record_id = recordIdFor(slug, event.source_id);

    const priorRow = getByIdStmt.get(record_id) as Row | undefined;
    const prior = priorRow ? rowToSnapshot(priorRow) : null;

    const body_inline = input.body_inline ?? null;
    const blob_hash = input.blob_hash ?? null;
    const etag = input.etag ?? null;

    const is_recurring = event.recurring_event_id != null ? 1 : 0;
    const is_all_day = event.is_all_day ? 1 : 0;
    const organizer = event.organizer?.email ?? null;
    const location = event.location ?? null;

    // received_at is preserved across replace — first-ever insert
    // stamps `now`, subsequent upserts keep the original so retention
    // remains meaningful. modified_at always tracks the provider's
    // `updated_at` (load-bearing for cursor-optimized sync ticks).
    const received_at = prior?.received_at ?? now;

    const record_payload = JSON.stringify(event);
    const prior_payload = prior ? JSON.stringify(prior.event) : null;

    upsertStmt.run({
      record_id,
      source_id: event.source_id,
      received_at,
      modified_at: event.updated_at,
      size_bytes: input.size_bytes,
      calendar_id: event.calendar_id,
      summary: event.summary,
      start_at: event.start_at,
      end_at: event.end_at,
      status: event.status,
      organizer,
      ical_uid: event.ical_uid,
      location,
      is_all_day,
      is_recurring,
      body_inline,
      blob_hash,
      etag,
      record_payload,
      prior_payload,
    });

    if (body_inline !== null && body_inline !== '') {
      ftsIndexRecord(db, ftsName, record_id, ftsTextFor(event, body_inline));
    } else {
      // Re-index summary-only so a future search still finds the row
      // by title even when the description lives in CAS.
      ftsIndexRecord(db, ftsName, record_id, ftsTextFor(event, null));
    }

    reportDelta(input.size_bytes - (prior?.size_bytes ?? 0));
    return prior;
  };

  const del = (source_id: string): CalendarDeleteResult => {
    const row = getBySourceStmt.get(source_id) as Row | undefined;
    if (!row) return { deleted: false, size_bytes: 0, blob_hash: null, prior: null };
    const prior = rowToSnapshot(row);
    deleteStmt.run(row.record_id);
    ftsDeleteRecord(db, ftsName, row.record_id);
    reportDelta(-row.size_bytes);
    return {
      deleted: true,
      size_bytes: row.size_bytes,
      blob_hash: row.blob_hash,
      prior,
    };
  };

  const get = (source_id: string): CalendarRowSnapshot | null => {
    const row = getBySourceStmt.get(source_id) as Row | undefined;
    return row ? rowToSnapshot(row) : null;
  };

  const getByRecordId = (record_id: string): CalendarRowSnapshot | null => {
    const row = getByIdStmt.get(record_id) as Row | undefined;
    return row ? rowToSnapshot(row) : null;
  };

  const stat = (source_id: string): CalendarRecordStat => {
    const row = getBySourceStmt.get(source_id) as Row | undefined;
    if (!row) return { exists: false };
    const event = JSON.parse(row.record_payload) as CanonicalEvent;
    return {
      exists: true,
      start_at: row.start_at,
      end_at: row.end_at,
      status: row.status as CanonicalEvent['status'],
      attendee_count: event.attendees?.length ?? 0,
      last_modified_at: row.modified_at,
    };
  };

  const buildListQuery = (
    query: CalendarListQuery,
  ): { sql: string; params: unknown[] } => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.start_since !== undefined) {
      where.push('start_at >= ?');
      params.push(query.start_since);
    }
    if (query.start_until !== undefined) {
      where.push('start_at < ?');
      params.push(query.start_until);
    }
    if (query.modified_since !== undefined) {
      where.push('modified_at > ?');
      params.push(query.modified_since);
    }
    if (query.calendar_id !== undefined) {
      where.push('calendar_id = ?');
      params.push(query.calendar_id);
    }
    if (query.status !== undefined) {
      where.push('status = ?');
      params.push(query.status);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const orderBy = query.order_by ?? 'start_at';
    const direction = query.direction ?? 'asc';
    // Tiebreaker on record_id so results are stable across runs.
    const orderClause =
      `ORDER BY ${orderBy} ${direction.toUpperCase()}, record_id ${direction.toUpperCase()}`;
    const limit = Math.max(
      1,
      Math.min(query.limit ?? DEFAULT_LIST_LIMIT, CALENDAR_MAX_LIST_LIMIT),
    );
    const sql = `
      SELECT * FROM ${tableName}
      ${whereClause}
      ${orderClause}
      LIMIT ?
    `;
    params.push(limit);
    return { sql, params };
  };

  const list = (query: CalendarListQuery): CalendarRecordHotFields[] => {
    const { sql, params } = buildListQuery(query);
    const rows = db.prepare(sql).all(...params) as Row[];
    return rows.map(rowHotFields);
  };

  const listSnapshots = (query: CalendarListQuery): CalendarRowSnapshot[] => {
    const { sql, params } = buildListQuery(query);
    const rows = db.prepare(sql).all(...params) as Row[];
    return rows.map(rowToSnapshot);
  };

  const search = (query: CalendarSearchQuery): CalendarSearchMatch[] => {
    const limit = Math.max(
      1,
      Math.min(query.limit ?? DEFAULT_LIST_LIMIT, CALENDAR_MAX_LIST_LIMIT),
    );
    // FTS5 MATCH parses its argument as a query expression, so a raw query
    // with punctuation (an email's `.`/`@`, a stray quote, a colon) is a
    // *syntax error*, not a miss. Reduce the query to bareword tokens
    // (letters/digits, whitespace-separated) before MATCH so a person's
    // NAME or their canonical EMAIL both match the indexed attendee /
    // summary text without throwing. Empty after stripping → no match.
    // ⛔ WAS a bare punctuation-strip, which also deleted a trailing `*` and so
    // silently turned a PREFIX query into an exact-token one — a false zero for
    // any caller probing whether this store holds a term. Now shares the one
    // definition in `collections/table.ts`, which quotes each token (protecting
    // FTS5 reserved words) and preserves `*` as a real prefix operator.
    const ftsQuery = toFtsMatch(query.query);
    if (ftsQuery === null) return [];
    // The FTS column (index 1) contains summary + description + location +
    // attendee / organizer text (see ftsTextFor). snippet() uses the
    // default 15-token window.
    const sql = `
      SELECT key, rank,
             snippet(${ftsName}, 1, '<b>', '</b>', '…', 15) AS snippet
      FROM ${ftsName}
      WHERE ${ftsName} MATCH ?
      ORDER BY rank
      LIMIT ?
    `;
    const stmt = db.prepare(sql);
    let matches = stmt.all(ftsQuery, limit) as Array<{
      key: string;
      rank: number;
      snippet: string;
    }>;
    // Which expression produced `matches` — the recency floor must rerun the
    // SAME one or it would surface rows relevance never considered.
    let usedExpr: string | null = ftsQuery;
    if (matches.length === 0) {
      // Same empty-result rung as the generic collection table: retry over the
      // tokens the index actually holds, in prefix form. An empty calendar and
      // "your query used a form the calendar does not store" are different
      // facts, and only one of them is worth reporting to the owner.
      const relaxed = relaxToPresentPrefixTokens(db, ftsName, query.query);
      if (relaxed !== null) {
        try {
          matches = stmt.all(relaxed, limit) as typeof matches;
          usedExpr = relaxed;
        } catch {
          matches = [];
          usedExpr = null;
        }
      }
    }
    // Same floor as the generic table, keyed on `modified_at`: a rescheduled or
    // corrected event is the calendar's version of a superseding mail, and its
    // `received_at` can be months older than the change that matters.
    if (usedExpr !== null) {
      matches = applyRecencyFloor(db, {
        ftsName, tableName, dateColumn: 'modified_at',
        expr: usedExpr, limit, matches,
      });
    }
    if (matches.length === 0) return [];
    const placeholders = matches.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT * FROM ${tableName} WHERE record_id IN (${placeholders})`)
      .all(...matches.map((m) => m.key)) as Row[];
    const byId = new Map<string, Row>(rows.map((r) => [r.record_id, r]));
    return matches
      .map((m) => {
        const row = byId.get(m.key);
        if (!row) return null;
        return {
          record_id: m.key,
          hot: rowHotFields(row),
          rank: m.rank,
          snippet: m.snippet,
        };
      })
      .filter((x): x is CalendarSearchMatch => x !== null);
  };

  const totalBytes = (): number => {
    const row = totalBytesStmt.get() as { total: number };
    return row.total;
  };

  const referencedBlobHashes = (): Set<string> => {
    const rows = referencedBlobsStmt.all() as Array<{ blob_hash: string }>;
    return new Set(rows.map((r) => r.blob_hash));
  };

  const eventCount = (): number => {
    const row = eventCountStmt.get() as { n: number };
    return row.n;
  };

  const overlapCount = (window_start: number, window_end: number): number => {
    // Empty / inverted window overlaps nothing. Guarded rather than trusted:
    // the SQL would silently return 0 anyway, but a caller passing end <= start
    // has a bug, and a 0 that means "nothing then" is indistinguishable from a
    // 0 that means "I asked wrong" on the surface where the owner decides.
    if (!(window_end > window_start)) return 0;
    const row = overlapCountStmt.get(window_end, window_start) as { n: number };
    return row.n;
  };

  const upcomingCount = (now: number, window_ms: number): number => {
    const row = upcomingCountStmt.get(now, now + window_ms) as { n: number };
    return row.n;
  };

  const summarizeParticipant: CalendarCollectionTable['summarizeParticipant'] = (
    emails,
    as_of,
  ) => {
    const canonical = [...new Set(
      emails.map((email) => email.trim().toLowerCase()).filter((email) => email.length > 0),
    )];
    if (canonical.length === 0 || !Number.isFinite(as_of)) {
      return { active_count: 0, historical_count: 0, observed_count: 0 };
    }
    const identifiersJson = JSON.stringify(canonical);
    const row = summarizeParticipantStmt.get(
      as_of,
      as_of,
      identifiersJson,
      identifiersJson,
    ) as {
      active_count: number | null;
      historical_count: number | null;
      observed_count: number;
    };
    return {
      active_count: row.active_count ?? 0,
      historical_count: row.historical_count ?? 0,
      observed_count: row.observed_count,
    };
  };

  const pruneOlderThan = (
    cutoff: number,
  ): {
    pruned_count: number;
    bytes_freed: number;
    blob_hashes_freed: string[];
  } => {
    const rows = db
      .prepare(`SELECT * FROM ${tableName} WHERE modified_at < ?`)
      .all(cutoff) as Row[];
    if (rows.length === 0) {
      return { pruned_count: 0, bytes_freed: 0, blob_hashes_freed: [] };
    }
    let bytes_freed = 0;
    const blob_hashes_freed: string[] = [];
    const pruneTx = db.transaction((victims: Row[]) => {
      for (const row of victims) {
        bytes_freed += row.size_bytes;
        if (row.blob_hash) blob_hashes_freed.push(row.blob_hash);
        deleteStmt.run(row.record_id);
        ftsDeleteRecord(db, ftsName, row.record_id);
      }
    });
    pruneTx(rows);
    reportDelta(-bytes_freed);
    return { pruned_count: rows.length, bytes_freed, blob_hashes_freed };
  };

  const dropSchema = (): void => {
    dropFtsTable(db, ftsName);
    db.exec(`DROP TABLE IF EXISTS ${tableName}`);
  };

  return {
    upsert,
    delete: del,
    get,
    getByRecordId,
    stat,
    list,
    listSnapshots,
    search,
    summarizeParticipant,
    totalBytes,
    referencedBlobHashes,
    eventCount,
    upcomingCount,
    overlapCount,
    pruneOlderThan,
    dropSchema,
    tableName,
    ftsName,
  };
};
