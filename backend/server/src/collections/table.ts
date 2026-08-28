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
  hasUnspacedScript,
  toFtsMatch,
  FTS_REINDEX_PAGE,
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
  /** Records ADJACENT IN TIME to an anchor, in a chosen direction — the reply
   *  direction (`next`) or the context direction (`prev`).
   *
   *  Exists because a conversational answer repeats none of the question's
   *  vocabulary, so no query finds it; only walking outward from a message that
   *  DID match can. Adjacency is by correspondents OR thread, so a provider
   *  that threads badly degrades rather than returning nothing. */
  neighbours(query: NeighbourQuery): CollectionRecord[];

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

  /** Index the normalised-address expression `countByAddress` compares on, so
   *  the count is a SEEK rather than a scan of the whole collection.
   *
   *  ⛔ OPT-IN PER COLLECTION, deliberately. The expression is
   *  `LOWER(TRIM(json_extract(hot_fields, '$.<field>')))`, which only makes
   *  sense where that hot field exists — mail has `from`, a file or calendar
   *  collection does not. Creating it on every table would make every unrelated
   *  collection write maintain an index nothing queries.
   *
   *  Idempotent (`IF NOT EXISTS`); safe to call on every boot. */
  ensureAddressIndex(field: string): void;

  /** Index the EXACT hot-field expression `findByHotFieldIn` compares on.
   *
   *  ⚠ A SIBLING OF `ensureAddressIndex`, NOT THE SAME INDEX. That one indexes
   *  `LOWER(TRIM(json_extract(...)))` because addresses fold; this one indexes
   *  the bare `json_extract(...)` because its caller compares exactly —
   *  Message-IDs are case-sensitive per RFC 5322 §3.6.4. SQLite matches an
   *  expression index only against the IDENTICAL expression, so one index
   *  cannot serve both and sharing one would silently serve neither.
   *
   *  Opt-in per collection and idempotent, for the same reasons. */
  ensureHotFieldIndex(field: string): void;

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
   *  FTS-only; `body_inline` stays the pure body, and is what search hands
   *  back as `body`. */
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
 *  returns no matches rather than issuing an invalid empty MATCH.
 *
 *  ⛔ EXPORTED so every FTS-backed collection shares ONE definition of the
 *  trailing-`*` convention. Three stores used to disagree about it silently:
 *  this one produced a real prefix (`"tok"*`), `contact-store` quoted the whole
 *  token (`"tok*"`, asterisk swallowed by the tokenizer) and `calendar-table`
 *  stripped `*` as punctuation before matching. Same query string, three
 *  behaviours, no error anywhere — and for a prefix probe that means a FALSE
 *  ZERO, which is exactly what makes a caller skip a store that has the data. */
/*  ⛔⛔ AND THEN IT WAS RE-IMPLEMENTED HERE ANYWAY, WHICH COST EXACTLY THE
 *  FAILURE THE PARAGRAPH ABOVE DESCRIBES. `@recued/fts` exports a `toFtsMatch`
 *  too; this file shadowed it with a byte-alike copy. They stayed equivalent
 *  until the package's learned to segment unspaced scripts — at which point the
 *  write side stored ` 续  约 `, the package's query side asked for `"续 约"`,
 *  and THIS copy still asked for `"续约"`, so `mail.search` returned a clean
 *  FALSE ZERO with both ends of the change correct. Measured, not reasoned:
 *  storage and expression both inspected and both right, result still empty.
 *
 *  ⇒ the re-export IS the fix. A comment claiming one definition is not one
 *  definition. */
export { toFtsMatch };

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


/** D-INDEX — the EMPTY-RESULT relaxation rung, shared by every FTS-backed
 *  collection. Given a plain-word query that matched nothing, return an
 *  expression over PREFIX forms of only those tokens the index actually
 *  contains, ANDed — or null when no token is present at all.
 *
 *  ⛔ WHY DROP-ABSENT AND NOT `OR`. The failing case is a model asking
 *  "Thornfield payment terms" of a mailbox holding "Thornfields — invoicing
 *  note". Exact-AND fails on the plural; prefix-AND STILL fails, because
 *  `payment` and `terms` appear nowhere. The naive fix — OR the tokens — would
 *  "succeed" by returning every mail containing `payment`, handing the model
 *  confidently irrelevant rows to answer from. Measured in this exact scenario,
 *  a run with nothing to go on invented `Net 30, 2% early payment discount`.
 *  Dropping absent tokens NEVER widens past what the corpus holds: the query
 *  degrades to `"Thornfield"*`, which is the one token that means anything here.
 *
 *  🔑 Cheap by construction: one capped existence probe per token, measured at
 *  ~0.02ms regardless of corpus size or term frequency (`LIMIT 1` with no
 *  `ORDER BY rank` never scores the full match set). It runs ONLY after a miss,
 *  so the hit path is untouched. */
/** Share of a search's limit reserved for the most RECENT matches.
 *
 *  ⛔⛔ WITHOUT THIS, A CORRECTION IS EVICTED BY THE THING IT CORRECTS. FTS5
 *  `rank` is BM25: it rewards term frequency and penalises document length, so a
 *  long old thread that repeats "Ridgeway renewal notice period" outranks a
 *  one-line "Update: Ridgeway is now 90 days" sent yesterday. Reproduced on this
 *  exact schema — 30 repetitive old rows and one recent correction, `ORDER BY
 *  rank LIMIT 20` returned the 20 old ones and DROPPED the correction entirely.
 *  The model then answers confidently from a superseded record, which reads as
 *  fabrication and is not.
 *
 *  ⚠ Eviction is routine, not an edge case: on a 50k-message corpus a
 *  correspondent's name matches 1,616 rows and `invoice` 317, against a default
 *  limit of 20 — ~99% of matches are dropped, and which 20 survive currently
 *  makes no reference to time at all.
 *
 *  Relevance still orders the result; recency just stops being truncatable. */
/** How many of an anchor's recipients the neighbour PAIR scope expands over. A
 *  wide distribution list would otherwise emit an unbounded OR chain into the
 *  SQL; the first few carry the conversation in every realistic case, and the
 *  thread clause still catches the rest when the provider threaded it. */
const NEIGHBOUR_PAIR_MAX_RECIPIENTS = 5;

const RECENCY_FLOOR_FRACTION = 0.25;

/** How many full matches the partial pass will exclude. Bounded because the
 *  point is to skip what the AND already returned, not to enumerate a corpus:
 *  past this many stale full matches the slots degrade to "some of them", which
 *  is the pre-fix behaviour and no worse. */
const FULL_MATCH_EXCLUSION_CAP = 2_000;

/** How many partial slots a page reserves. Tunable because the cost is paid on
 *  EVERY search — including the majority where nothing needs correcting — while
 *  the benefit only lands when a re-phrased correction exists. Coverage is
 *  measured deterministically against the position matrix, so the leanest count
 *  that holds coverage is a measurement, not a guess. */
const partialSlotCount = (limit: number): number => {
  const raw = Number(process.env.RECUED_PARTIAL_SLOT_COUNT);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  // 15%, not 25%: measured, recency ordering reaches the correction 6/6 at
  // EVERY noise level with a single slot, so extra slots buy coverage that is
  // already there and cost ~700 tokens each on every search. Kept above 1
  // because a lone slot is a coin flip when the correction and a distractor
  // share a timestamp, which is ordinary.
  return Math.max(1, Math.floor(limit * 0.15));
};

/** ⛔⛔ AN `AND` QUERY THAT MATCHES ALMOST NOTHING IS A FAILED SEARCH WEARING A
 *  SUCCESS'S CLOTHES, and until 2026-08-28 only the ZERO case was treated as
 *  one. FTS5 ANDs bare terms, so one over-specific word collapses the result:
 *  measured on bench 276, `"Kestrel invoice first release item A"` returned
 *  exactly ONE row — "invoice" appears only in the last message of a
 *  seven-message negotiation — and that single row was handed back looking like
 *  the answer set. 10 of 11 runs opened with a query of that shape.
 *
 *  🔑 RELAXATION ALONE COULD NOT HAVE FIXED IT. `relaxToPresentPrefixTokens`
 *  drops tokens absent from the WHOLE INDEX and re-ANDs the rest; every term
 *  here exists somewhere, so relaxing produced the same AND and the same one
 *  row. Widening the trigger without widening the MECHANISM would have been a
 *  no-op that looked like a fix — the broadening has to come from the OR pass
 *  (`partialMatches`), which is why this reuses it rather than adding a second.
 *
 *  ⚠ 2, not 1: a first search returning TWO rows failed the same way and for
 *  the same reason. Absolute rather than a fraction of `limit`, because "the
 *  AND matched almost nothing" is a fact about the corpus, not about how many
 *  rows the caller asked for. */
const NEAR_EMPTY_MATCH_CEILING = 2;
/** How many OR-matched rows a near-empty page may pull in. Capped so a narrow
 *  query cannot turn into a whole-mailbox dump, and clamped to the caller's own
 *  `limit` so broadening never overruns what was asked for. Token cost past the
 *  first few rows is already bounded by `SEARCH_BODY_TOTAL_CHARS` — rows beyond
 *  the body budget arrive as metadata plus `body_truncated`. */
const NEAR_EMPTY_FILL_CAP = 12;

/** Is this a query the substrate may BROADEN without answering a different
 *  question?
 *
 *  ⛔⛔ ONE RULE, TWO CALLERS, AND IT HAS TO STAY THAT WAY. A caller who wrote
 *  real FTS5 syntax (`OR` / `NEAR` / `"phrase"` / an explicit `fox*`) asked for
 *  something specific; every widening path owes them the same restraint. This
 *  started life inline in `relaxToPresentPrefixTokens` and was extracted when
 *  near-empty broadening became a SECOND widening path and immediately
 *  regressed the test that pins it — `thornfield OR nothingmatches` came back
 *  with a row. A guard that protects one door is not a guard.
 *
 *  ⛔ AND / OR / NOT / NEAR ARE OPERATORS MADE ENTIRELY OF LETTERS, so the
 *  charset test alone lets a deliberate expression through as "plain words".
 *  Both halves are load-bearing. */
export const isPlainWordQuery = (raw: string): boolean => {
  if (!/^[\p{L}\p{N}\s]+$/u.test(raw.trim())) return false;
  if (/(?:^|\s)(?:AND|OR|NOT|NEAR)(?:\s|$)/.test(raw)) return false;
  return true;
};

export const relaxToPresentPrefixTokens = (
  db: Database.Database,
  ftsName: string,
  raw: string,
): string | null => {
  if (!isPlainWordQuery(raw)) return null;
  const tokens = raw.match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  const probe = db.prepare(
    `SELECT 1 FROM ${ftsName} WHERE ${ftsName} MATCH ? LIMIT 1`,
  );
  const present: string[] = [];
  for (const t of new Set(tokens)) {
    const expr = `"${t.replace(/"/g, '""')}"*`;
    try {
      if (probe.get(expr) !== undefined) present.push(expr);
    } catch {
      // A token that can't be expressed is simply not usable for relaxation.
    }
  }
  if (present.length === 0) return null;
  return present.join(' ');
};

/** The recency-floor merge, shared by every FTS-backed collection.
 *
 *  Returns the relevance-ordered page with the most-recent matches guaranteed
 *  present. `dateColumn` differs per store on purpose: mail uses `received_at`
 *  (when it arrived), calendar `modified_at` (when the event last CHANGED —
 *  a rescheduled meeting is exactly the correction case, and its `received_at`
 *  may be months old).
 *
 *  ⛔ RESERVE ONLY FOR RECENT ROWS THE RANK PASS MISSED. Reserving the whole
 *  floor unconditionally under-fills the page: most recent rows are already in
 *  the rank result, so those slots buy nothing and the caller silently gets
 *  fewer rows than it asked for (measured: 16 returned for a limit of 20).
 *
 *  ⛔ RERUNS THE SAME EXPRESSION the rank pass used, so it can never widen the
 *  match set — a floor that surfaced rows relevance never considered would be
 *  inventing results, not preserving them. */
export const applyRecencyFloor = <T extends { key: string }>(
  db: Database.Database,
  opts: {
    ftsName: string; tableName: string; dateColumn: string;
    expr: string; limit: number; matches: T[];
  },
): T[] => {
  const { ftsName, tableName, dateColumn, expr, limit, matches } = opts;
  // Only when the page is actually TRUNCATED: under the limit everything
  // matching is already returned and this would be pure cost.
  if (matches.length < limit) return matches;
  const floorN = Math.max(1, Math.floor(limit * RECENCY_FLOOR_FRACTION));
  try {
    const recent = db.prepare(`
      SELECT key, rank
      FROM ${ftsName}
      WHERE ${ftsName} MATCH ?
      ORDER BY (
        SELECT ${dateColumn} FROM ${tableName}
        WHERE ${tableName}.record_id = ${ftsName}.key
      ) DESC
      LIMIT ?
    `).all(expr, floorN) as T[];
    // ⚠⚠ THE `catch` BELOW SWALLOWS A SYNTAX ERROR IN *OUR OWN* SQL, NOT JUST A
    // BAD USER EXPRESSION — and the two failures are not alike. Retiring the
    // snippet column from this SELECT left `SELECT key, rank,` with a dangling
    // comma; every call threw, every call returned `matches` unchanged, and the
    // recency floor was a NO-OP with nothing logged and no test-visible edge
    // except the three that assert its behaviour directly. A defensive catch
    // around a query built from a caller's string is right; the same catch also
    // covers the parts WE wrote, and there it converts a total outage into
    // silence. If this grows a third failure mode, split it.
    const present = new Set(matches.map((r) => r.key));
    const missing = recent.filter((r) => !present.has(r.key));
    if (missing.length === 0) return matches;
    const budget = Math.max(0, limit - missing.length);
    return [...matches.slice(0, budget), ...missing].slice(0, limit);
  } catch {
    // An improvement, not a dependency: on any failure relevance order stands.
    return matches;
  }
};

/** Rows matching only SOME of the query's terms — BM25 over an OR of them, with
 *  the full-match set removed.
 *
 *  ⛔⛔ RANK WITH BM25, NOT TERM-PRESENCE WEIGHTS. Measured on 50k real
 *  messages: weighting by which-terms-matched scored EVERY candidate
 *  identically (2,999 rows tied), making the slots an arbitrary draw — one
 *  returned an eBay baseball-card receipt for `invoice payment terms`. BM25 uses
 *  term frequency and document length, so ranks differ and the same query
 *  returns "Re: Payment of Invoices", "letter regarding payment of invoices",
 *  "PG&E Payments". Precision ~1.5/4 -> ~3.5/4.
 *
 *  ⛔ SUBTRACT THE FULL-MATCH SET FIRST. Rows matching every term outscore
 *  partial ones on any sane ranking, so without the subtraction these slots just
 *  re-elect what the AND already returned. BOTH of my prototypes made exactly
 *  that mistake before the corpus caught it.
 *
 *  ⚠ Coverage limit, measured: a correction sharing TWO terms with the query
 *  surfaces at any competitive depth; one sharing a SINGLE rare term surfaces
 *  only while fewer than ~4 newer rows share that term. An information limit,
 *  not a ranking one. */
const partialMatches = (
  db: Database.Database,
  ftsName: string,
  tableName: string,
  terms: readonly string[],
  slots: number,
  fullKeys: ReadonlySet<string>,
): Array<{ key: string; rank: number }> => {
  if (terms.length < 2 || slots <= 0) return [];
  const orExpr = terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
  // ⛔ ORDER BY RECENCY, NOT RELEVANCE. Measured: with ~20+ competing partial
  // rows, BM25 ordering finds the correction in 2/6 cells at ANY slot count —
  // it cannot tell a correction from the many similar partial matches a real
  // corpus carries (one query on 50k messages had 2,999 of them). What DOES
  // separate them is time: a correction is recent, and most partial noise is
  // not. Relevance already had its pass — these slots are the recency lane.
  // ⛔⛔ SPLIT THE LANE — NEITHER ORDERING DOMINATES, AND EACH SWEEP I RAN WAS
  // BIASED TOWARD THE ONE IT TESTED.
  //   · RECENCY finds a correction newer than the partial noise. Measured 6/6
  //     at every noise level with ONE slot, where BM25 managed 2/6 at five.
  //   · BM25 finds a correction that is OLDER than the noise but a better
  //     lexical fit — the case recency loses outright (phrase 2/3, 5 stale,
  //     20 newer rows all fresher than the truth).
  // A fixture with a recent truth proves recency; one with an older truth proves
  // relevance. Both are real, so the slots are split rather than chosen.
  // ⛔⛔ THREAD-LINKED FIRST — THE ONLY SIGNAL HERE THAT ACTUALLY SEPARATES A
  // CORRECTION FROM CHATTER. Ordering lanes cannot: a decoy that is newer wins
  // recency, a decoy that is terser wins BM25, and the trap harness showed both
  // happening while the real correction went unsurfaced. But a correction is
  // usually a REPLY — it shares a thread with the record it corrects — and
  // ambient traffic does not. Measured on the trap fixture: the correction was
  // the top thread-linked candidate while both decoys, on other threads, were
  // excluded outright.
  const threadLane = (n: number): Array<{ key: string; rank: number }> => {
    if (n <= 0 || fullKeys.size === 0) return [];
    try {
      const threads = new Set<string>();
      for (const k of fullKeys) {
        const row = db.prepare(
          `SELECT hot_fields FROM ${tableName} WHERE record_id = ?`,
        ).get(k) as { hot_fields?: string } | undefined;
        if (!row?.hot_fields) continue;
        const tid = (JSON.parse(row.hot_fields) as Record<string, unknown>).thread_id;
        if (typeof tid === 'string' && tid.length > 0) threads.add(tid);
      }
      if (threads.size === 0) return [];
      const placeholders = [...threads].map(() => '?').join(',');
      return db.prepare(`
        SELECT f.key AS key, 0 AS rank
        FROM ${ftsName} f
        JOIN ${tableName} d ON d.record_id = f.key
        WHERE ${ftsName} MATCH ?
          AND json_extract(d.hot_fields, '$.thread_id') IN (${placeholders})
        ORDER BY d.received_at DESC
        LIMIT ?
      `).all(orExpr, ...threads, n + fullKeys.size)
        .filter((r) => !fullKeys.has((r as { key: string }).key))
        .slice(0, n) as Array<{ key: string; rank: number }>;
    } catch {
      return [];
    }
  };

  const half = Math.max(1, Math.ceil(slots / 2));
  const dateOrder =
    `(SELECT received_at FROM ${tableName} WHERE ${tableName}.record_id = ${ftsName}.key) DESC`;
  const fetch = (order: string, n: number) => db.prepare(`
      SELECT key, rank
      FROM ${ftsName}
      WHERE ${ftsName} MATCH ?
      ORDER BY ${order}
      LIMIT ?
    `).all(orExpr, n + fullKeys.size) as Array<{ key: string; rank: number }>;
  try {
    // Priority: thread-linked, then newest, then best-matching.
    const byThread = threadLane(Math.max(1, Math.floor(slots / 3)));
    const claimed = new Set(byThread.map((r) => r.key));
    const byDate = fetch(dateOrder, half)
      .filter((r) => !fullKeys.has(r.key) && !claimed.has(r.key))
      .slice(0, Math.max(0, half - byThread.length));
    const taken = new Set([...claimed, ...byDate.map((r) => r.key)]);
    const byRank = fetch('rank', slots)
      .filter((r) => !fullKeys.has(r.key) && !taken.has(r.key))
      .slice(0, Math.max(0, slots - byThread.length - byDate.length));
    return [...byThread, ...byDate, ...byRank];
  } catch {
    return [];
  }
};


/** Messages that sit in a MATCHED THREAD but match no query term themselves.
 *
 *  ⛔⛔ EVERY OTHER MECHANISM HERE IS DOWNSTREAM OF "THE ROW MATCHES SOME TERM",
 *  AND THE ANSWER OFTEN MATCHES NONE. A thread is a conversation:
 *      msg1  "Ridgeway renewal notice period: move from 30d to 90d?"   ← matches
 *      msg2  "no lets be fair & change it to 60d so we can both be happy" ← the ANSWER
 *  msg2 carries no query term at all, so it is not in the AND set, not in the
 *  relaxed set, and not even an OR candidate — the partial lanes cannot reach
 *  it, including the thread-linked one, which still filters the OR set.
 *
 *  Lexical retrieval structurally cannot find a conversational reply. Pulling
 *  thread neighbours is not a ranking tweak; it is the only way such a row
 *  becomes visible at all.
 *
 *  ⚠ Bounded per thread and per page: a long thread would otherwise flood the
 *  result with everything anyone said. Newest-first, because a reply that
 *  supersedes comes after the message it answers. */
const threadNeighbours = (
  db: Database.Database,
  tableName: string,
  seedKeys: ReadonlySet<string>,
  perThread: number,
  budget: number,
): Array<{ key: string; rank: number }> => {
  if (seedKeys.size === 0 || budget <= 0) return [];
  try {
    const threads = new Set<string>();
    for (const k of seedKeys) {
      const row = db.prepare(`SELECT hot_fields FROM ${tableName} WHERE record_id = ?`)
        .get(k) as { hot_fields?: string } | undefined;
      if (!row?.hot_fields) continue;
      const tid = (JSON.parse(row.hot_fields) as Record<string, unknown>).thread_id;
      if (typeof tid === 'string' && tid.length > 0) threads.add(tid);
    }
    if (threads.size === 0) return [];
    const out: Array<{ key: string; rank: number }> = [];
    for (const tid of threads) {
      if (out.length >= budget) break;
      const rows = db.prepare(`
        SELECT record_id AS key
        FROM ${tableName}
        WHERE json_extract(hot_fields, '$.thread_id') = ?
        ORDER BY received_at DESC
        LIMIT ?
      `).all(tid, perThread + seedKeys.size) as Array<{ key: string }>;
      for (const r of rows) {
        if (out.length >= budget) break;
        if (seedKeys.has(r.key)) continue;
        out.push({ key: r.key, rank: 0 });
        if (out.filter((x) => x.key === r.key).length >= perThread) break;
      }
    }
    return out.slice(0, budget);
  } catch {
    return [];
  }
};

/** Messages ADJACENT IN TIME to an anchor record, in a chosen direction.
 *
 *  🔑 DIRECTION IS THE POINT. The answer to a question comes AFTER it; the
 *  context for a claim comes BEFORE. A thread filter returns the exchange
 *  undifferentiated and the caller pays for messages it does not need, then has
 *  to work out the order itself.
 *
 *  ⛔ ADJACENCY IS BY CORRESPONDENTS, NOT `thread_id`. Threading is
 *  provider-supplied and often absent or wrong; who the mail is between is
 *  intrinsic to the record. `thread_id` is used as a NARROWING hint when the
 *  anchor carries one, never as the requirement.
 *
 *  This exists because a conversational answer is unreachable by search — it
 *  repeats none of the question's vocabulary — so no query, however relaxed,
 *  finds it. Only walking outward from a message that DID match can. */
export interface NeighbourQuery {
  readonly anchor_id: string;
  /** Messages after the anchor, oldest-first (the reply direction). */
  readonly next?: number;
  /** Messages before the anchor, newest-first (the context direction). */
  readonly prev?: number;
}

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
  // ⛔ ONE-TIME FTS REBUILD WHEN THE STORED TEXT'S FORMAT CHANGES. The note on
  // the upsert path below says a composer change "would require a one-time
  // re-upsert sweep"; this is that sweep, driven by `FTS_CONTENT_FORMAT` rather
  // than by remembering. Format 2 space-separates unspaced scripts so a
  // 2-character CJK/Thai word matches as an adjacent phrase instead of only
  // where it begins a run.
  //
  // ⚠ Streams with `.iterate()` — a mailbox is sized to 2 GB (D-230) and
  // `.all()` would materialise it. Runs ONCE per index per server: the format is
  // recorded only after this returns, so a throw retries on the next boot.
  createFtsTable(db, ftsName, {
    reindex: () => {
      // ⛔⛔ PAGED, NOT `.iterate()`. better-sqlite3 REFUSES a write while a read
      // statement is still iterating — "This database connection is busy
      // executing a query" — and this loop writes to the FTS table for every row
      // it reads. Measured: the throw escaped, and (with the drop that used to
      // precede it) left the index EMPTY, taking `search(sandhurst)` from 3 to 0
      // with no test red. `.all()` finishes its statement before the writes
      // begin; the keyset page keeps memory bounded on a 2 GB mailbox.
      const page = db.prepare(
        `SELECT * FROM ${tableName} WHERE record_id > ? ORDER BY record_id LIMIT ?`,
      );
      let after = '';
      for (;;) {
        const rows = page.all(after, FTS_REINDEX_PAGE) as Row[];
        if (rows.length === 0) break;
        for (const row of rows) {
          const record = rowToRecord(row);
          const text = opts.ftsTextFor ? opts.ftsTextFor(record) : record.body_inline;
          if (text !== undefined && text.length > 0) {
            ftsIndexRecord(db, ftsName, record.record_id, text);
          }
        }
        after = rows[rows.length - 1].record_id;
      }
    },
  });

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
  /** ⛔ THE JSON PATH IS A LITERAL, NOT A BIND, AND THAT IS THE WHOLE FIX.
   *
   *  This was one static statement with the path bound (`json_extract(
   *  hot_fields, ?)`), which reads as tidy and is unindexable BY CONSTRUCTION:
   *  a bound path differs per call, so no expression index can cover it. Every
   *  `countByAddress` was therefore a full scan of the collection — and its one
   *  caller is the chat short-circuit for "how many emails from <Name>?", over
   *  `collection.mail`, which D-230 sized to 2 GB.
   *
   *  Specialising per field makes the expression constant, so
   *  `ensureAddressIndex` below can index exactly it. `LOWER` is ASCII-only;
   *  the JS side `asciiLower`s the value to fold identically, and `TRIM` strips
   *  the ASCII spaces an `item.address` never carries (belt + braces). A
   *  missing field → `json_extract` NULL → `NULL = ?` is not true → not
   *  counted. Semantics unchanged in every case; only the plan moves.
   *
   *  ⚠ `field` is validated against `FILTER_KEY_PATTERN` before it reaches the
   *  SQL text — it is interpolated now, not bound. */
  // ⚠ `Database.Statement`, NOT an inline `import('better-sqlite3').Statement`.
  // Both are type-only and erase identically, but the D-212 chokepoint ratchet
  // scans for the dynamic-import TEXT and exempts only `.Database` — so the
  // inline form reddens it as if this file constructed a driver.
  const countByAddressStmts = new Map<string, Database.Statement>();
  const addressExpr = (field: string): string =>
    `LOWER(TRIM(json_extract(hot_fields, '$.${field}')))`;
  const countByAddressStmtFor = (field: string) => {
    let stmt = countByAddressStmts.get(field);
    if (!stmt) {
      stmt = db.prepare(
        `SELECT COUNT(*) AS n FROM ${tableName} WHERE ${addressExpr(field)} = ?`,
      );
      countByAddressStmts.set(field, stmt);
    }
    return stmt;
  };
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

/** ⛔⛔ `snippetTokens` WAS RETIRED WITH THE SNIPPET ITSELF (2026-08-28), and
 *  what it was tuning is worth keeping because it is the whole argument.
 *
 *  It sized an FTS5 `snippet()` window, in TOKENS. Format 2 made a CJK token ONE
 *  CHARACTER, so a fixed count silently became a fixed CHARACTER window for
 *  unspaced scripts — roughly a seventh of the text a Latin row got. Measured
 *  against a live model on the CJK inverted-spread task: the index did its job
 *  (mail reached 6/7 against 0/7) and the model still answered "I found the
 *  email but cannot see the details" in four of those, because the window
 *  stopped before the figure it needed. The count was raised to 96 for unspaced
 *  queries and LEFT AT THE DEFAULT 15 FOR LATIN.
 *
 *  ⛔ THAT FIX TREATED THE SYMPTOM AND LEFT THE SAME DEFECT LIVE FOR EVERY LATIN
 *  ROW. Bench 276 — a seven-message negotiation whose unit price is DERIVED,
 *  never stated — reached the right mail 11/11 and answered correctly 0/11,
 *  emitting SEVEN DISTINCT wrong totals, the pivotal window cutting at `"At that
 *  volume I can…"`, one token before the two discount rates the sum needed. The
 *  control rules out the model: those same messages rendered whole into ONE api
 *  call answered 9-11/11 correct — chronological, shuffled, and under the
 *  verbatim `RECUED_CORE_TEXT` envelope alike, so the envelope's `"short, calm
 *  reply"` (the first suspect) is innocent.
 *
 *  🔑 A WINDOW OVER A ROW CANNOT BE TUNED INTO A ROW. Every value is wrong for
 *  some question, because the window is centred on the QUERY and the answer is
 *  wherever it happens to sit. The index answers WHICH ROWS; the base table
 *  answers WHAT IS IN THEM — see BODY HYDRATION in `search`. */

/** Per-record body cap. Sized to carry a normal business email WHOLE — the case
 *  where a preview and a record differ is exactly the case that failed — while
 *  keeping one long row from taking the whole budget. */
const SEARCH_BODY_MAX_CHARS = 2000;
/** Across the whole result set. `limit` can reach MAX_LIST_LIMIT, and a wide
 *  search returning full bodies for every hit would blow the turn's packet.
 *  Spent in rank order, so the tail degrades before the head. */
const SEARCH_BODY_TOTAL_CHARS = 12000;

const search = (query: CollectionSearchQuery): CollectionSearchMatch[] => {
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
    // ⛔ THE INDEX ANSWERS "WHICH ROWS", NOT "WHAT IS IN THEM". No `snippet()`:
    // the ids come from FTS and the CONTENT comes from the base table below,
    // which is the round-trip this search was making anyway.
    const sql = `
      SELECT key, rank
      FROM ${ftsName}
      WHERE ${ftsName} MATCH ?
      ORDER BY rank
      LIMIT ?
    `;
    const stmt = db.prepare(sql);
    type FtsRow = { key: string; rank: number };
    let matches: FtsRow[];
    // Which expression actually produced `matches` — the recency pass must run
    // the SAME one, or it would surface rows the relevance pass never saw.
    let usedExpr: string | null = null;
    // ⛔⛔ THE RAW ATTEMPT IS SKIPPED FOR UNSPACED SCRIPTS, AND THAT IS THE
    // WHOLE JOIN. A bare CJK query like `续约` is VALID FTS5, so the raw attempt
    // below does not throw — it simply matches nothing against a per-grapheme
    // index and returns, never reaching `toFtsMatch`. Measured: storage read
    // ` 续  约  通 …`, the match expression read `"续 约"`, and the search still
    // came back empty because that expression was never the one that ran.
    // ⇒ a write side and a query side that AGREE are not enough; the path
    // between them has to actually use the query side.
    const unspaced = hasUnspacedScript(query.query);
    try {
      if (unspaced) throw new Error('unspaced: use the tokenized form');
      // Try the query as a raw FTS5 expression first — preserves OR / NOT /
      // NEAR / prefix (`fox*`) / phrase / grouping for callers that use them.
      matches = stmt.all(query.query, limit) as FtsRow[];
      usedExpr = query.query;
    } catch {
      // Invalid FTS5 (an email / path query's `.` / `@` raises a syntax
      // error) — retry with the query reduced to safe quoted word-tokens
      // (bag-of-words AND, prefix preserved). No word tokens → no matches.
      const safe = toFtsMatch(query.query);
      if (safe === null) return [];
      matches = stmt.all(safe, limit) as FtsRow[];
      usedExpr = safe;
    }
    if (matches.length === 0) {
      // Nothing matched. Before reporting an empty store — which the caller
      // cannot distinguish from "you have no mail about this" — retry over the
      // tokens the index actually holds, in prefix form.
      const relaxed = relaxToPresentPrefixTokens(db, ftsName, query.query);
      if (relaxed !== null) {
        try {
          matches = stmt.all(relaxed, limit) as FtsRow[];
          usedExpr = relaxed;
        } catch {
          matches = [];
        }
      }
    }
    // ── RECENCY FLOOR ──────────────────────────────────────────────────────
    if (usedExpr !== null) {
      matches = applyRecencyFloor(db, {
        ftsName, tableName, dateColumn: 'received_at',
        expr: usedExpr, limit, matches,
      });
    }
    // ── PARTIAL SLOTS (opt-in) ─────────────────────────────────────────────
    // The correction that RE-PHRASES is not evicted — it is never RETRIEVED,
    // because the query ANDs terms it does not carry ("actually Ridgeway is 90
    // days" has neither "renewal" nor "notice"). These slots surface it,
    // LABELLED, so the reader can weigh it rather than being handed it as an
    // equal. The label is the point: unlabelled it is indistinguishable from
    // evidence the query actually asked for.
    const partialKeys = new Set<string>();
    // Kept apart from `partialKeys`: these matched NOTHING, and saying so is the
    // point — the label has to be honest about why a weak row is on the page.
    const threadKeys = new Set<string>();
    // Two independent reasons to run the OR pass. The env flag is the standing
    // opt-in for surfacing a re-phrased CORRECTION on an otherwise healthy page.
    // `nearEmpty` is a distress signal: the AND matched almost nothing, so what
    // came back is not a short answer, it is a narrow question. Same mechanism,
    // same `partial_match` label — only the trigger and the slot count differ.
    const partialSlotsOn = process.env.RECUED_PARTIAL_SLOTS === '1';
    // ⛔ NOT FOR AN EXPLICIT EXPRESSION. `thornfield OR nothingmatches` returning
    // nothing is the CORRECT answer to what was asked; broadening it answers a
    // different question, and this regressed exactly that test when the guard
    // lived only in `relaxToPresentPrefixTokens`.
    const nearEmpty = matches.length <= NEAR_EMPTY_MATCH_CEILING
      && isPlainWordQuery(query.query);
    if (partialSlotsOn || nearEmpty) {
      const terms = (query.query.match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter((t) => t.length >= 2);
      // ⛔ EXCLUDE **ALL** FULL MATCHES, NOT THE PAGE OF THEM. `matches` is
      // already capped at `limit`, so building the exclusion set from it leaves
      // every full match BEYOND the cap eligible for a partial slot — and those
      // are exactly the repetitive old rows BM25 loves. Measured on the
      // position matrix: with 50 stale full matches and a limit of 20, the 30
      // uncovered ones filled all five slots and the correction vanished, while
      // the same case passed at rank-depth 20. A ceiling that silently changes
      // what a filter EXCLUDES is the worst kind, because coverage looks fine
      // until the corpus is big enough.
      const allFull = new Set<string>();
      try {
        const andExpr = usedExpr ?? toFtsMatch(query.query);
        if (andExpr !== null) {
          for (const r of db.prepare(
            `SELECT key FROM ${ftsName} WHERE ${ftsName} MATCH ? LIMIT ?`,
          ).all(andExpr, FULL_MATCH_EXCLUSION_CAP) as Array<{ key: string }>) {
            allFull.add(r.key);
          }
        }
      } catch { /* fall back to the page below */ }
      for (const m of matches) allFull.add(m.key);
      // A healthy page reserves a couple of slots for a correction. A
      // near-empty one is trying to REBUILD a result set, so it fills toward
      // the caller's limit instead of sipping at it.
      const slots = nearEmpty
        ? Math.max(0, Math.min(limit - matches.length, NEAR_EMPTY_FILL_CAP))
        : partialSlotCount(limit);
      const extra = partialMatches(db, ftsName, tableName, terms, slots, allFull);
      for (const r of extra) partialKeys.add(r.key);
      matches = [...matches, ...extra];
      // Thread neighbours LAST: they are the only rows here that matched
      // nothing, so they are the weakest claim on the page — but for a
      // conversational answer they are the only claim there is.
      // ⚠ Still gated on the standing opt-in. A near-empty page broadens by
      // TERMS, which is a defensible widening of the question the caller asked;
      // pulling in rows that matched NO term is a different and larger claim,
      // and turning both on with one measurement would leave neither
      // attributable.
      if (partialSlotsOn) {
        const seeds = new Set(matches.map((m) => m.key));
        const neighbours = threadNeighbours(db, tableName, seeds, 2,
          Math.max(1, Math.floor(limit * 0.1)));
        for (const r of neighbours) { threadKeys.add(r.key); matches.push(r); }
      }
    }

    if (matches.length === 0) return [];

    // Hydrate hot_fields in a single query to avoid N round-trips.
    const placeholders = matches.map(() => '?').join(',');
    const hotRows = db
      .prepare(
        `SELECT record_id, hot_fields, received_at, body_inline, blob_hash FROM ${tableName} `
        + `WHERE record_id IN (${placeholders})`,
      )
      .all(...matches.map((m) => m.key)) as Array<{
        record_id: string;
        hot_fields: string;
        received_at: number;
        body_inline: string | null;
        blob_hash: string | null;
      }>;
    const hotById = new Map<string, Record<string, unknown>>();
    // ⛔ THE DATE RIDES THE HYDRATION QUERY THAT WAS ALREADY HAPPENING — one more
    // column, no extra round-trip. Without it a searched thread reaches the
    // reader in relevance order with nothing to re-sort by, which is fatal for
    // anything where sequence carries the meaning.
    const atById = new Map<string, number>();
    const bodyById = new Map<string, { inline: string | null; cas: boolean }>();
    for (const r of hotRows) {
      hotById.set(r.record_id, JSON.parse(r.hot_fields));
      atById.set(r.record_id, r.received_at);
      bodyById.set(r.record_id, { inline: r.body_inline, cas: r.blob_hash !== null });
    }
    // ── BODY HYDRATION ─────────────────────────────────────────────────────
    // ⛔⛔ THE ROUND-TRIP WAS ALREADY HAPPENING. This is `WHERE record_id IN
    // (...)` over the base table — the rows are being fetched by id regardless,
    // so the CONTENT costs one more column, not one more query. What it
    // replaces is reading `snippet()` as though it were the record: a window of
    // N tokens centred on the match terms, which on bench 276 cut one token
    // before the two discount rates the sum needed (reached 11/11, correct
    // 0/11, seven distinct wrong totals). The same messages rendered whole into
    // one api call answered 9-11/11 — the model was never shown the numbers.
    //
    // ⚠ BOUNDED TWICE, AND BOTH BOUNDS ARE LOAD-BEARING. Per record, because
    // one long thread would otherwise fill the turn; across the set, because
    // `limit` can be MAX_LIST_LIMIT and a wide search would blow the packet.
    // Matches arrive in rank order, so the budget is spent on the most relevant
    // rows first and the tail degrades to metadata-only rather than the head
    // being cut. A row that gets no body is NOT silently thinner — it carries
    // `body_truncated`, because a fragment read as a whole record is the exact
    // failure this fixes.
    let bodyBudget = SEARCH_BODY_TOTAL_CHARS;
    const bodyFor = (key: string): { body?: string; body_truncated?: boolean } => {
      const entry = bodyById.get(key);
      if (entry === undefined) return {};
      const raw = entry.inline;
      if (raw === null || raw.length === 0) {
        // ⛔ `body_inline IS NULL` MEANS TWO DIFFERENT THINGS and only
        // `blob_hash` separates them: a record whose body spilled to CAS
        // (>64 KB — content exists, this table holds no blob handle to reach
        // it) versus one that genuinely has no body. Collapsing them would make
        // an unreachable 64 KB contract look like an empty note, which is the
        // same class of lie the snippet told. `body_truncated` means "there is
        // content here you were not handed"; `{}` means "there is none".
        return entry.cas ? { body_truncated: true } : {};
      }
      if (bodyBudget <= 0) return { body_truncated: true };
      const room = Math.min(SEARCH_BODY_MAX_CHARS, bodyBudget);
      const cut = raw.length > room;
      const body = cut ? raw.slice(0, room) : raw;
      bodyBudget -= body.length;
      return cut ? { body, body_truncated: true } : { body };
    };
    return matches.map((m) => ({
      record_id: m.key,
      hot_fields: hotById.get(m.key) ?? {},
      ...(atById.has(m.key) ? { received_at: atById.get(m.key) as number } : {}),
      rank: m.rank,
      ...bodyFor(m.key),
      ...(partialKeys.has(m.key) ? { partial_match: true } : {}),
      ...(threadKeys.has(m.key) ? { thread_context: true } : {}),
    }));
  };

  const neighbours = (q: NeighbourQuery): CollectionRecord[] => {
    const anchor = db.prepare(
      `SELECT record_id, received_at, hot_fields FROM ${tableName} WHERE record_id = ?`,
    ).get(q.anchor_id) as { received_at: number; hot_fields: string } | undefined;
    if (!anchor) return [];
    const hot = JSON.parse(anchor.hot_fields) as Record<string, unknown>;
    const thread = typeof hot.thread_id === 'string' ? hot.thread_id : null;
    const from = typeof hot.from === 'string' ? hot.from : null;
    const to = Array.isArray(hot.to)
      ? hot.to.filter((v): v is string => typeof v === 'string' && v.length > 0)
      : [];
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (thread !== null) {
      clauses.push(`json_extract(hot_fields, '$.thread_id') = ?`);
      params.push(thread);
    }
    // ⛔⛔ THE PAIR, BOTH DIRECTIONS — NOT THE SENDER. This clause used to be
    // `from = <anchor's from>`, described as "follows the correspondents". It
    // follows ONE ENDPOINT, and that is wrong in both directions:
    //
    //   anchored on THEIR message → matches their other mail and NEVER the
    //     owner's, so a reply the owner typed OUTSIDE the thread — a forward, a
    //     fresh mail sent because replying was inconvenient — falls out
    //     entirely. Measured on a four-message fixture: missed.
    //   anchored on the OWNER'S message → `from = me@` matches EVERY message
    //     the owner ever sent, to anyone. Measured: pulled in unrelated mail to
    //     a third party. On a real mailbox that is the whole sent folder,
    //     bounded only by the next/prev cursor.
    //
    // A conversation is the unordered PAIR {A, B}: `[me,him] + [him,me]`. The
    // thread stays OR'd in as a hint, so a provider that threads well still
    // benefits and one that threads badly degrades to the pair rather than to
    // one endpoint.
    //
    // ⚠ `to` is a JSON ARRAY, so this cannot be a scalar equality —
    // `json_extract` would compare against the array TEXT and match nothing (the
    // same trap `countByAddress` documents for its scalar-only contract).
    if (from !== null) {
      for (const other of to.slice(0, NEIGHBOUR_PAIR_MAX_RECIPIENTS)) {
        clauses.push(
          `(json_extract(hot_fields, '$.from') = ? AND EXISTS (`
          + `SELECT 1 FROM json_each(hot_fields, '$.to') WHERE value = ?))`,
        );
        params.push(from, other);
        clauses.push(
          `(json_extract(hot_fields, '$.from') = ? AND EXISTS (`
          + `SELECT 1 FROM json_each(hot_fields, '$.to') WHERE value = ?))`,
        );
        params.push(other, from);
      }
    }
    if (clauses.length === 0) return [];
    const scope = `(${clauses.join(' OR ')})`;
    const out: Row[] = [];
    const take = (dir: 'next' | 'prev', n: number): void => {
      if (n <= 0) return;
      const cmp = dir === 'next' ? '>' : '<';
      const order = dir === 'next' ? 'ASC' : 'DESC';
      out.push(...db.prepare(`
        SELECT * FROM ${tableName}
        WHERE ${scope} AND received_at ${cmp} ? AND record_id != ?
        ORDER BY received_at ${order}, record_id ${order}
        LIMIT ?
      `).all(...params, anchor.received_at, q.anchor_id, n) as Row[]);
    };
    take('next', q.next ?? 0);
    take('prev', q.prev ?? 0);
    return out.map(rowToRecord);
  };

  const countByAddress = (field: string, value: string): number => {
    // ⚠ The field is now INTERPOLATED into the SQL text (that is what makes it
    // indexable), so this validation is load-bearing rather than hygiene.
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
    const row = countByAddressStmtFor(field).get(wanted) as { n: number };
    return row.n;
  };

  const hotFieldExpr = (field: string): string =>
    `json_extract(hot_fields, '$.${field}')`;

  const ensureHotFieldIndex = (field: string): void => {
    if (!FILTER_KEY_PATTERN.test(field)) {
      throw new CollectionTableError(
        `invalid hot field index: ${field} (allowed: /[A-Za-z_][A-Za-z0-9_]*/)`,
      );
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${tableName}_hot_${field}`
      + ` ON ${tableName} (${hotFieldExpr(field)})`,
    );
  };

  const ensureAddressIndex = (field: string): void => {
    if (!FILTER_KEY_PATTERN.test(field)) {
      throw new CollectionTableError(
        `invalid address index field: ${field} (allowed: /[A-Za-z_][A-Za-z0-9_]*/)`,
      );
    }
    // ⚠ The indexed expression must be BYTE-IDENTICAL to the one in the
    // WHERE clause — SQLite matches expression indexes syntactically, so a
    // cosmetic difference (a space, a reordered call) yields an index that
    // exists, is maintained on every write, and is never used. Both come from
    // `addressExpr` for exactly that reason.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${tableName}_addr_${field}`
      + ` ON ${tableName} (${addressExpr(field)})`,
    );
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
    // ⛔ THE PATH IS A LITERAL. It used to be bound — and the comment here said
    // so approvingly, citing `list` / `countByAddress` as precedent. A bound
    // path is unindexable by construction, so this scanned the whole
    // collection: no LIMIT, over `collection.mail`, which D-230 sized to 2 GB.
    // `field` is already validated against FILTER_KEY_PATTERN above, which is
    // what makes the interpolation safe.
    const sql = `
      SELECT * FROM ${tableName}
      WHERE ${hotFieldExpr(field)} IN (${placeholders})
      ORDER BY received_at DESC, record_id DESC
    `;
    const rows = db.prepare(sql).all(...wanted) as Row[];
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
    neighbours,
    ensureAddressIndex,
    ensureHotFieldIndex,
    findByHotFieldIn,
    totalBytes,
    referencedBlobHashes,
    pruneOlderThan,
    dropSchema,
    tableName,
    ftsName,
  };
};
