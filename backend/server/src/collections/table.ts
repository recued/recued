/** Phase D (D-106) — generic per-collection SQLite wrapper.
 *
 *  One `CollectionTable` per `(platform, slug)` pair. Wraps the table
 *  + FTS5 companion behind a uniform synchronous surface: upsert /
 *  get / list / search / delete plus pruner + bookkeeping. CAS blob
 *  I/O is NOT the table's concern — callers hand in records that
 *  already carry `body_inline` (≤ 64 KB) or `blob_hash` (> 64 KB);
 *  the table enforces the split invariant and stores the row.
 *
 *  Blob orphan cleanup is deferred to the Phase B orphan-CAS sweep
 *  (extended in Commit 6 to walk collection tables). `delete` and
 *  `pruneOlderThan` return the blob_hashes they dropped so callers
 *  that want eager cleanup can pipe them into `BlobStore.delete()`;
 *  callers that don't care leave them for the sweep.
 *
 *  Schema (one table per collection):
 *    CREATE TABLE collection_{platform}_{slug_hash} (
 *      record_id   TEXT PRIMARY KEY,
 *      received_at INTEGER NOT NULL,
 *      modified_at INTEGER NOT NULL,
 *      hot_fields  TEXT NOT NULL,            -- JSON blob
 *      size_bytes  INTEGER NOT NULL,
 *      source_id   TEXT NOT NULL,
 *      body_inline TEXT,
 *      blob_hash   TEXT
 *    );
 *
 *  The `{slug_hash}` is a 10-char SHA-256 prefix of the user-chosen
 *  slug — guarantees SQL-safe table names regardless of what the
 *  TOML contains. Per-adapter hot-field indexes (e.g. thread_id via
 *  `json_extract`) land in the concrete adapter modules (Commit 12+).
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

import {
  createFtsTable,
  dropFtsTable,
  indexRecord as ftsIndexRecord,
  deleteRecord as ftsDeleteRecord,
} from '@recued/fts';
import { isActor } from '@recued/contracts';
import type {
  Actor,
  CollectionListQuery,
  CollectionPlatform,
  CollectionRecord,
  CollectionSearchMatch,
  CollectionSearchQuery,
} from '@recued/contracts';

/** Inline / CAS split threshold. Records with `body_inline` larger
 *  than this are rejected — the caller must push to CAS first and
 *  pass `blob_hash` instead. Matches the Phase A shared_store cutoff
 *  so the CAS sharing rules stay uniform across the codebase. */
export const INLINE_CUTOFF_BYTES = 64 * 1024;

/** Maximum records returned by a single `list` / `search` call.
 *  Protects the rpc dispatcher from unbounded result sets; callers
 *  paginate by filtering on `received_at`. */
export const MAX_LIST_LIMIT = 500;

/** Default page size when `limit` is omitted. Matches the Phase A
 *  `shared.search` default — chosen so a 1 KB average record yields
 *  ~50 KB of payload, comfortably under the 1 MB rpc envelope. */
const DEFAULT_LIST_LIMIT = 50;

export interface CollectionTable {
  /** Insert or replace the record keyed by `record_id`. Returns the
   *  prior record when this was an update, `null` on first insert.
   *  Callers can inspect the prior record's `blob_hash` to decide
   *  whether to eagerly evict an orphaned CAS blob (the orphan sweep
   *  handles it otherwise). */
  upsert(record: CollectionRecord): CollectionRecord | null;
  /** Remove by `record_id`. Returns the deleted record (for caller-
   *  driven blob cleanup) or `null` when the id was unknown. */
  delete(record_id: string): CollectionRecord | null;
  /** Fetch by `record_id` or `null` when absent. */
  get(record_id: string): CollectionRecord | null;
  /** Filtered listing — hot-field equality filters + `received_at`
   *  range + pagination. Results ordered by `received_at DESC` so
   *  the most-recent records surface first. */
  list(query: CollectionListQuery): CollectionRecord[];
  /** FTS5 body search. CAS-stored records are not indexed and never
   *  appear here (documented limit — matches `shared_store`). */
  search(query: CollectionSearchQuery): CollectionSearchMatch[];

  /** Exact `COUNT(*)` of rows whose SCALAR `field` hot-field equals `value`,
   *  compared case-insensitively over ASCII after trimming (`LOWER(TRIM(...))`
   *  on the column, `asciiLower`-trimmed `value` — both fold `A–Z` only, so
   *  the compare is self-consistent; see `asciiLower`). Precise for a scalar
   *  address-valued field: the mail adapter stores `from` as a BARE email
   *  address (`item.address` only — no display name, no angle brackets), so a
   *  lower-trim equality is an exact sender match with NO substring near-miss
   *  (`alice@x` never matches `xalice@x` or `alice@x.evil`). A full `COUNT(*)`
   *  → the result is EXACT regardless of table size (no list/search page cap to
   *  fail closed around — the count can't be hidden past a recency window).
   *
   *  SCALAR fields only: an ARRAY-valued hot field (mail's `to` / `cc` are
   *  stored as JSON arrays) makes `json_extract` return the array TEXT, not a
   *  member, so this won't match an address inside it — count those with a
   *  `json_each` predicate instead (not needed for the `from` sender count
   *  this serves today). NON-ASCII letters are compared case-SENSITIVELY
   *  (SQLite `LOWER` is ASCII-only): a caller needing full Unicode
   *  case-insensitivity must normalize a key at ingest (the mail from-count
   *  short-circuit instead defers a non-ASCII address to the LLM). A `field`
   *  that fails the filter-key identifier check throws `CollectionTableError`;
   *  an empty `value` returns `0` (nothing to match). Rows missing the field
   *  (`json_extract` → NULL) never count. */
  countByAddress(field: string, value: string): number;

  /** D-184 Decision 2 — batched scalar hot-field membership lookup.
   *  Returns every row whose SCALAR `field` hot-field exactly equals one
   *  of `values`, via a single parameterized `IN (...)` query. The
   *  compare is EXACT (case-sensitive, no trim) — the engagement
   *  resolver's mail-twin join feeds it the already-normalized
   *  `rfc_message_id` (Message-IDs are case-sensitive per RFC 5322
   *  §3.6.4, so no folding here). `field` is validated against the
   *  filter-key identifier pattern (throws `CollectionTableError`
   *  otherwise); duplicate / empty `values` are de-duplicated and an
   *  empty set returns `[]`. Ordered `received_at DESC, record_id DESC`
   *  so a deterministic row wins when several mail rows share a
   *  Message-ID (Inbox + Sent copies). SCALAR fields only — an
   *  array-valued hot field won't match a member (same caveat as
   *  `countByAddress`). */
  findByHotFieldIn(field: string, values: readonly string[]): CollectionRecord[];

  /** Sum of `size_bytes` across every row. Used to prime the
   *  collection's gate at boot. */
  totalBytes(): number;
  /** Every distinct `blob_hash` referenced by a live row. Consumed
   *  by the orphan-CAS sweep to build its keep-set. */
  referencedBlobHashes(): Set<string>;

  /** Delete every row with `received_at < cutoff`. Returns the
   *  deleted count, the bytes freed, and the list of orphaned blob
   *  hashes so retention can pipe them into the CAS sweep or an
   *  eager eviction path. */
  pruneOlderThan(cutoff: number): {
    pruned_count: number;
    bytes_freed: number;
    blob_hashes_freed: string[];
  };

  /** Drop both the data + FTS tables. Called from `dispose()` only
   *  for ephemeral test fixtures; production collections drop on
   *  uninstall, not on close. */
  dropSchema(): void;

  /** Stable SQL identifier for the data table — `collection_{platform}_{slug_hash}`. */
  readonly tableName: string;
  /** Stable SQL identifier for the FTS5 companion — `{tableName}_fts`. */
  readonly ftsName: string;
}

export interface CreateCollectionTableOptions {
  db: Database.Database;
  platform: CollectionPlatform;
  /** User-chosen slug — hashed before concatenation into SQL
   *  identifiers so TOML content can't break out of the grammar. */
  slug: string;
  /** Phase B gate hook. Every write / delete / prune reports the
   *  signed byte delta so the collection's gate tracks the live
   *  `SUM(size_bytes)` without needing a separate scan. Exceptions
   *  are swallowed — a misbehaving gate never breaks a write. */
  onBytesChanged?: (delta: number) => void;
  /** Optional FTS-text composer. Returns the text to FTS5-index for a
   *  record; when omitted the index is `body_inline` only (the historical
   *  default — body content search). Collections whose searchable surface
   *  is more than the body supply a composer — mail composes
   *  from + to + subject + body so a "mail from / about <person>" query
   *  matches the SENDER / SUBJECT, not just the body (the calendar-table
   *  analog, whose composite index covers attendees). The composed text is
   *  FTS-only; `body_inline` stays the pure body for snippets / display. */
  ftsTextFor?: (record: CollectionRecord) => string;
}

export class CollectionTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollectionTableError';
  }
}

// ────────────────────────────────────────────────────────────────
// SQL identifier helpers
// ────────────────────────────────────────────────────────────────

/** 10-char SHA-256 prefix of the slug. Gives ~10^12 distinct values
 *  per platform — plenty for user-realistic deployments while keeping
 *  table names short. Collision risk is the caller's problem: two
 *  slugs hashing to the same prefix would collide on the shared
 *  table; in practice the probability is negligible for the ≤100
 *  collections a single server runs. */
const slugHash = (slug: string): string =>
  createHash('sha256').update(slug).digest('hex').slice(0, 10);

/** Platform identifiers are from a closed union (`CollectionPlatform`)
 *  and slug_hash is hex — both safe to concatenate into DDL. Belt +
 *  braces: validate the final identifier against a strict pattern
 *  before use so any future widening of the platform union doesn't
 *  silently introduce an injection vector. */
const IDENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const assertIdent = (name: string): string => {
  if (!IDENT_PATTERN.test(name)) {
    throw new CollectionTableError(`invalid SQL identifier: ${name}`);
  }
  return name;
};

/** Hot-field filter keys are narrowed to simple JS identifiers so
 *  the JSON path stays well-formed after `$.${key}` interpolation.
 *  Recipes that want nested access can always pre-flatten their
 *  hot fields. */
const FILTER_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** ⛔ THE ONLY CORRECT WAY TO DISCOVER COLLECTION DATA TABLES.
 *
 *  A collection creates SEVEN tables, not one: the data table
 *  `collection_<platform>_<10-hex>` plus its FTS5 companion `<data>_fts`,
 *  which SQLite then backs with five shadow tables — `_fts_data`,
 *  `_fts_idx`, `_fts_content`, `_fts_docsize`, `_fts_config`. Every one of
 *  those matches a `name LIKE 'collection_mail_%'` scan, and NONE of them has
 *  `record_id` / `received_at` / `hot_fields`. A caller that scans by LIKE and
 *  then selects a data column throws `no such column` on the first shadow it
 *  reaches — and inside a housekeeping task that throw is caught, counted, and
 *  after three consecutive cycles disables the task for 24 h. The producer
 *  then never emits anything again, while the cycle keeps reporting success.
 *  Found 2026-08-04 by the long-horizon audit, live on three producers.
 *
 *  ⚠ An `endsWith('_fts')` filter is NOT sufficient and reads as though it
 *  were — it strips the virtual table and leaves all five shadows. Match the
 *  EXACT name shape instead, which also rejects any unexpected schema-drift
 *  table before its name reaches SQL.
 *
 *  (The reasoning is `mail-union-twin-resolver.ts`'s, generalised: it had the
 *  right predicate for one caller while twenty others open-coded the loose
 *  scan.) */
export const listCollectionDataTables = (
  db: Database.Database,
  platform: CollectionPlatform,
): string[] => {
  const exact = new RegExp(`^collection_${platform}_[0-9a-f]{10}$`);
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name LIKE 'collection_${platform}_%'`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).filter((n) => exact.test(n));
};

// ────────────────────────────────────────────────────────────────
// Internal row shape
// ────────────────────────────────────────────────────────────────

interface Row {
  record_id: string;
  received_at: number;
  modified_at: number;
  hot_fields: string;
  size_bytes: number;
  source_id: string;
  body_inline: string | null;
  blob_hash: string | null;
  // D-161 P1 — origin provenance facet. NOT NULL DEFAULT 'system' in the
  // schema; collection rows are adapter-synced (never recipe-written), so
  // the write-actor is always 'system'. `origin_contract_id` always NULL
  // here (kept for shape parity). Optional in the read shape for dev DBs
  // read before the column migration.
  origin_actor?: string;
  origin_contract_id?: string | null;
}

const rowToRecord = (row: Row): CollectionRecord => {
  const record: CollectionRecord = {
    record_id: row.record_id,
    received_at: row.received_at,
    modified_at: row.modified_at,
    hot_fields: JSON.parse(row.hot_fields) as Record<string, unknown>,
    size_bytes: row.size_bytes,
    source_id: row.source_id,
  };
  if (row.body_inline !== null) record.body_inline = row.body_inline;
  if (row.blob_hash !== null) record.blob_hash = row.blob_hash;
  // D-161 P1 — surface the origin provenance facet (I-5). Column is NOT
  // NULL DEFAULT 'system'; the `?? 'system'` guards a pre-migration row.
  record.origin_actor = isActor(row.origin_actor) ? row.origin_actor : 'system';
  if (row.origin_contract_id != null) record.origin_contract_id = row.origin_contract_id;
  return record;
};

const validateRecord = (rec: CollectionRecord): void => {
  if (typeof rec.record_id !== 'string' || rec.record_id.length === 0) {
    throw new CollectionTableError('record_id required');
  }
  if (rec.body_inline !== undefined && rec.blob_hash !== undefined) {
    throw new CollectionTableError(
      'body_inline and blob_hash are mutually exclusive',
    );
  }
  if (rec.body_inline !== undefined) {
    const bytes = Buffer.byteLength(rec.body_inline, 'utf8');
    if (bytes > INLINE_CUTOFF_BYTES) {
      throw new CollectionTableError(
        `body_inline exceeds INLINE_CUTOFF_BYTES (${bytes} > ${INLINE_CUTOFF_BYTES}); caller must CAS-put first`,
      );
    }
  }
};

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

/** Turn an arbitrary user query into a valid FTS5 MATCH expression.
 *  Raw FTS5 MATCH treats `. : @ - ( ) ,` and bare AND/OR/NOT/NEAR as
 *  syntax, so an email / phone / path query (`pat.lee@x.com`) raises
 *  `fts5: syntax error near "."`. We extract the Unicode word tokens the
 *  `unicode61` tokenizer would index — each optionally carrying a trailing
 *  `*` prefix operator — and join them by space (FTS5 implicit AND). Every
 *  token becomes a QUOTED phrase literal (`"word"`, or `"word"*` for a
 *  prefix token) so an FTS5 keyword or stray char can't be reinterpreted
 *  as an operator. The stem must be quoted even for prefix tokens — a bare
 *  reserved-word stem (`OR*` / `AND* `/ `NOT*`) still raises an FTS5 syntax
 *  error, but `"OR"*` is accepted and keeps prefix behavior. Returns null
 *  when the query has no word tokens (all punctuation) — the caller then
 *  returns no matches rather than issuing an invalid empty MATCH. */
const toFtsMatch = (raw: string): string | null => {
  const tokens = raw.match(/[\p{L}\p{N}]+\*?/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens
    .map((t) => (t.endsWith('*') ? `"${t.slice(0, -1)}"*` : `"${t}"`))
    .join(' ');
};

/** Lower-case ASCII `A–Z` only — matching SQLite's `LOWER()`, which does NOT
 *  fold non-ASCII letters. Used by `countByAddress` so its JS-side value folds
 *  IDENTICALLY to the SQL-side `LOWER(...)` on the column: a JS `.toLowerCase()`
 *  Unicode-folds (`Ö → ö`) while SQLite would not, so the two sides could
 *  disagree for a non-ASCII address (a row would fail to match even its OWN
 *  value in a different case). ASCII-folding both sides makes the compare
 *  self-consistent; non-ASCII letters are compared exactly (case-sensitive),
 *  consistently on both sides. Full Unicode case-insensitivity would need a
 *  normalized key stored at ingest — callers that require it (and the mail
 *  from-count short-circuit, which defers non-ASCII addresses to the LLM)
 *  handle it above this layer. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

export const createCollectionTable = (
  opts: CreateCollectionTableOptions,
): CollectionTable => {
  const { db, platform, slug } = opts;
  const onBytesChanged = opts.onBytesChanged;

  const hash = slugHash(slug);
  const tableName = assertIdent(`collection_${platform}_${hash}`);
  const ftsName = assertIdent(`${tableName}_fts`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      record_id   TEXT PRIMARY KEY,
      received_at INTEGER NOT NULL,
      modified_at INTEGER NOT NULL,
      hot_fields  TEXT NOT NULL,
      size_bytes  INTEGER NOT NULL,
      source_id   TEXT NOT NULL,
      body_inline TEXT,
      blob_hash   TEXT,
      -- D-161 P1 — origin provenance facet. Collection rows are
      -- adapter-synced server-side (never recipe-written), so the
      -- write-actor is always 'system'; NOT NULL DEFAULT 'system'
      -- stamps every insert without touching the upsert statement (I-5).
      origin_actor       TEXT NOT NULL DEFAULT 'system',
      origin_contract_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${tableName}_received_at ON ${tableName} (received_at);
    CREATE INDEX IF NOT EXISTS idx_${tableName}_modified_at ON ${tableName} (modified_at);
    CREATE INDEX IF NOT EXISTS idx_${tableName}_source_id   ON ${tableName} (source_id);
    -- D-123 producers look records up BY THREAD, once per record. Without
    -- this index that lookup is a full table scan, so a producer pass over N
    -- mails costs O(N^2). Measured on a file-backed WAL db, one lookup:
    --   2k mails 0.205ms -> 0.003ms | 20k 1.93ms -> 0.004ms
    --   100k mails 21.8ms -> 0.004ms (5800x)
    -- At 100k mails a full pass went from ~36 minutes of pure scanning to
    -- nothing. thread-signals and task-signal-density-per-thread both have
    -- this shape; the producer contract is per-mail-record, so the cost is
    -- quadratic in the corpus and invisible on a small one.
    --
    -- PARTIAL, so platforms whose hot_fields carry no thread_id (calendar,
    -- file) pay nothing for it. SQLite proves an equality test implies IS NOT
    -- NULL and still uses the index -- verified with EXPLAIN, not assumed.
    -- NOTE: no backticks in this comment. It lives inside a JS template
    -- literal, where a backtick ends the string and the error surfaces as a
    -- TS syntax error 30 lines away.
    CREATE INDEX IF NOT EXISTS idx_${tableName}_thread_id
      ON ${tableName} (json_extract(hot_fields, '$.thread_id'))
      WHERE json_extract(hot_fields, '$.thread_id') IS NOT NULL;
  `);
  // D-161 P1 — additive origin-column upgrade for dev DBs that predate
  // the column (pre-launch zero installs — no data backfill beyond the
  // 'system' default). `CREATE TABLE IF NOT EXISTS` above skips existing
  // tables, so guard each ALTER with a PRAGMA table_info check.
  {
    const existing = new Set(
      (db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[])
        .map((c) => c.name),
    );
    if (!existing.has('origin_actor')) {
      db.exec(
        `ALTER TABLE ${tableName} ADD COLUMN origin_actor TEXT NOT NULL DEFAULT 'system'`,
      );
    }
    if (!existing.has('origin_contract_id')) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN origin_contract_id TEXT`);
    }
  }
  createFtsTable(db, ftsName);

  const reportDelta = (delta: number): void => {
    if (!onBytesChanged || delta === 0) return;
    try { onBytesChanged(delta); } catch { /* never break writes */ }
  };

  const getStmt = db.prepare(`SELECT * FROM ${tableName} WHERE record_id = ?`);
  const deleteStmt = db.prepare(
    `DELETE FROM ${tableName} WHERE record_id = ?`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO ${tableName} (
       record_id, received_at, modified_at, hot_fields,
       size_bytes, source_id, body_inline, blob_hash
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(record_id) DO UPDATE SET
       received_at = excluded.received_at,
       modified_at = excluded.modified_at,
       hot_fields  = excluded.hot_fields,
       size_bytes  = excluded.size_bytes,
       source_id   = excluded.source_id,
       body_inline = excluded.body_inline,
       blob_hash   = excluded.blob_hash`,
  );
  const totalBytesStmt = db.prepare(
    `SELECT COALESCE(SUM(size_bytes), 0) AS total FROM ${tableName}`,
  );
  const referencedBlobsStmt = db.prepare(
    `SELECT DISTINCT blob_hash FROM ${tableName} WHERE blob_hash IS NOT NULL`,
  );
  // The JSON path + the wanted value are BIND params (the SQL text is static),
  // so this prepares once and serves every `countByAddress` field. `LOWER` is
  // ASCII-only; the JS side `asciiLower`s the value to fold identically (so the
  // compare is self-consistent for any address) and `TRIM` strips the ASCII
  // spaces an `item.address` never carries (belt + braces). A missing field
  // → `json_extract` NULL → `NULL = ?` is not true → not counted.
  const countByAddressStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM ${tableName}
     WHERE LOWER(TRIM(json_extract(hot_fields, ?))) = ?`,
  );
  const ftsDeleteRowStmt = db.prepare(
    `DELETE FROM ${ftsName} WHERE key = ?`,
  );

  const upsert = (record: CollectionRecord): CollectionRecord | null => {
    validateRecord(record);
    const priorRow = getStmt.get(record.record_id) as Row | undefined;
    const prevRecord = priorRow ? rowToRecord(priorRow) : null;

    upsertStmt.run(
      record.record_id,
      record.received_at,
      record.modified_at,
      JSON.stringify(record.hot_fields ?? {}),
      record.size_bytes,
      record.source_id,
      record.body_inline ?? null,
      record.blob_hash ?? null,
    );

    // FTS text: a collection-supplied composite (e.g. mail's
    // from + subject + body, so sender / subject are searchable) when a
    // composer is configured, else the inline body only (the historical
    // default). A composer keeps a CAS-stored record (body_inline
    // undefined) searchable by its headers; without one, CAS records
    // intentionally do not participate in full-text search.
    // Composing happens per-upsert, so adding / changing a composer
    // reindexes a row only when it is next synced or re-upserted — rows
    // already in the table keep their old FTS text until then. Pre-launch
    // (zero installs) there are no such rows, so no reindex pass is needed
    // (no-migration rule); a post-launch composer change would require a
    // one-time re-upsert sweep.
    const ftsText = opts.ftsTextFor ? opts.ftsTextFor(record) : record.body_inline;
    if (ftsText !== undefined && ftsText.length > 0) {
      ftsIndexRecord(db, ftsName, record.record_id, ftsText);
    } else {
      ftsDeleteRecord(db, ftsName, record.record_id);
    }

    reportDelta(record.size_bytes - (prevRecord?.size_bytes ?? 0));
    return prevRecord;
  };

  const del = (record_id: string): CollectionRecord | null => {
    const row = getStmt.get(record_id) as Row | undefined;
    if (!row) return null;
    const record = rowToRecord(row);
    deleteStmt.run(record_id);
    ftsDeleteRowStmt.run(record_id);
    reportDelta(-record.size_bytes);
    return record;
  };

  const get = (record_id: string): CollectionRecord | null => {
    const row = getStmt.get(record_id) as Row | undefined;
    return row ? rowToRecord(row) : null;
  };

  const list = (query: CollectionListQuery): CollectionRecord[] => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.since !== undefined) {
      where.push('received_at >= ?');
      params.push(query.since);
    }
    if (query.until !== undefined) {
      where.push('received_at < ?');
      params.push(query.until);
    }
    if (query.modified_since !== undefined) {
      where.push('modified_at >= ?');
      params.push(query.modified_since);
    }
    if (query.filters) {
      for (const [key, value] of Object.entries(query.filters)) {
        if (!FILTER_KEY_PATTERN.test(key)) {
          throw new CollectionTableError(
            `invalid filter key: ${key} (allowed: /[A-Za-z_][A-Za-z0-9_]*/)`,
          );
        }
        // json_extract returns JSON booleans as integers 1/0; match the
        // encoding here so callers can filter with native JS booleans.
        // SQLite can't bind booleans directly either — always coerce.
        const bound = typeof value === 'boolean' ? (value ? 1 : 0) : value;
        where.push(`json_extract(hot_fields, ?) = ?`);
        params.push(`$.${key}`, bound);
      }
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
    // Tiebreak on record_id so results are stable across runs when
    // multiple rows share a received_at value (common for batch
    // ingests). Tiebreaker is DESC so the "latest" record wins for
    // any given timestamp, matching the overall ordering intent.
    const sql = `
      SELECT * FROM ${tableName}
      ${whereClause}
      ORDER BY received_at DESC, record_id DESC
      LIMIT ?
    `;
    params.push(limit);
    const rows = db.prepare(sql).all(...params) as Row[];
    return rows.map(rowToRecord);
  };

  const search = (query: CollectionSearchQuery): CollectionSearchMatch[] => {
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
    // `blob_text` is column index 1 (key is column 0, UNINDEXED).
    // snippet(table, colIdx, start, end, ellipsis, tokens). Using
    // the default 15-token window.
    const sql = `
      SELECT key, rank,
             snippet(${ftsName}, 1, '<b>', '</b>', '…', 15) AS snippet
      FROM ${ftsName}
      WHERE ${ftsName} MATCH ?
      ORDER BY rank
      LIMIT ?
    `;
    const stmt = db.prepare(sql);
    type FtsRow = { key: string; rank: number; snippet: string };
    let matches: FtsRow[];
    try {
      // Try the query as a raw FTS5 expression first — preserves OR / NOT /
      // NEAR / prefix (`fox*`) / phrase / grouping for callers that use them.
      matches = stmt.all(query.query, limit) as FtsRow[];
    } catch {
      // Invalid FTS5 (an email / path query's `.` / `@` raises a syntax
      // error) — retry with the query reduced to safe quoted word-tokens
      // (bag-of-words AND, prefix preserved). No word tokens → no matches.
      const safe = toFtsMatch(query.query);
      if (safe === null) return [];
      matches = stmt.all(safe, limit) as FtsRow[];
    }
    if (matches.length === 0) return [];

    // Hydrate hot_fields in a single query to avoid N round-trips.
    const placeholders = matches.map(() => '?').join(',');
    const hotRows = db
      .prepare(
        `SELECT record_id, hot_fields FROM ${tableName} WHERE record_id IN (${placeholders})`,
      )
      .all(...matches.map((m) => m.key)) as Array<{
        record_id: string;
        hot_fields: string;
      }>;
    const hotById = new Map<string, Record<string, unknown>>();
    for (const r of hotRows) {
      hotById.set(r.record_id, JSON.parse(r.hot_fields));
    }
    return matches.map((m) => ({
      record_id: m.key,
      hot_fields: hotById.get(m.key) ?? {},
      rank: m.rank,
      snippet: m.snippet,
    }));
  };

  const countByAddress = (field: string, value: string): number => {
    // The field rides in as a bind param ($.<field>), so there is no SQL
    // injection vector — but validate it to a clean identifier (like list
    // filter keys) so a malformed JSON path can't silently mis-resolve.
    if (!FILTER_KEY_PATTERN.test(field)) {
      throw new CollectionTableError(
        `invalid count field: ${field} (allowed: /[A-Za-z_][A-Za-z0-9_]*/)`,
      );
    }
    // ASCII-fold the value to match the SQL `LOWER(...)` on the column (see
    // `asciiLower`) — a Unicode `.toLowerCase()` here would diverge from
    // SQLite's ASCII-only LOWER for a non-ASCII address.
    const wanted = asciiLower(value.trim());
    if (wanted.length === 0) return 0;
    const row = countByAddressStmt.get(`$.${field}`, wanted) as { n: number };
    return row.n;
  };

  const findByHotFieldIn = (
    field: string,
    values: readonly string[],
  ): CollectionRecord[] => {
    if (!FILTER_KEY_PATTERN.test(field)) {
      throw new CollectionTableError(
        `invalid filter key: ${field} (allowed: /[A-Za-z_][A-Za-z0-9_]*/)`,
      );
    }
    // De-duplicate + drop empties. Bound the placeholder count well
    // under SQLite's parameter limit (the sole caller passes ≤ one
    // resolver page of ids); a larger set is clamped rather than
    // silently truncating membership semantics across chunks.
    const wanted = Array.from(
      new Set(values.filter((v) => typeof v === 'string' && v.length > 0)),
    ).slice(0, MAX_LIST_LIMIT);
    if (wanted.length === 0) return [];
    const placeholders = wanted.map(() => '?').join(', ');
    // Bind the JSON path as a param (like `list` / `countByAddress`) — the
    // FILTER_KEY_PATTERN check already rules out injection, this just keeps
    // the path off the SQL string.
    const sql = `
      SELECT * FROM ${tableName}
      WHERE json_extract(hot_fields, ?) IN (${placeholders})
      ORDER BY received_at DESC, record_id DESC
    `;
    const rows = db.prepare(sql).all(`$.${field}`, ...wanted) as Row[];
    return rows.map(rowToRecord);
  };

  const totalBytes = (): number => {
    const row = totalBytesStmt.get() as { total: number };
    return row.total;
  };

  const referencedBlobHashes = (): Set<string> => {
    const rows = referencedBlobsStmt.all() as Array<{ blob_hash: string }>;
    return new Set(rows.map((r) => r.blob_hash));
  };

  const pruneOlderThan = (cutoff: number): {
    pruned_count: number;
    bytes_freed: number;
    blob_hashes_freed: string[];
  } => {
    const rows = db
      .prepare(`SELECT * FROM ${tableName} WHERE received_at < ?`)
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
        ftsDeleteRowStmt.run(row.record_id);
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
    list,
    search,
    countByAddress,
    findByHotFieldIn,
    totalBytes,
    referencedBlobHashes,
    pruneOlderThan,
    dropSchema,
    tableName,
    ftsName,
  };
};
