/** Durable `data.shared.*` storage (D-103 Phase A).
 *
 *  SQLite-backed key/value store for user-written records. Values ≤ 64 KB
 *  live inline in the `value_inline` column; larger values are streamed
 *  through the content-addressed blob store and referenced by `blob_hash`.
 *  Identical by-hash contents share a single on-disk blob (same dedup as
 *  the cache layer).
 *
 *  Key rules (enforced by callers via a validator helper):
 *    - Flat string. Dots are literal characters, NOT hierarchy. Two
 *      records `deal.12345` and `deal.67890` are independent.
 *    - 512-char cap on the key.
 *    - Keys must start with `shared.` or `data.shared.` in user-facing
 *      terms; this module operates on the trailing portion after the
 *      prefix. Routing lives in the kernel ingredient handler.
 *
 *  FTS5 companion table `shared_store_fts` indexes the JSON blob for
 *  inline entries. Blob-backed values (>64 KB) are NOT FTS-indexed — that's
 *  a documented limit. Phase B / C may revisit if needed. */

import type Database from 'better-sqlite3';
import { prefixUpperBound } from './prefix-range.js';
import { FTS_REINDEX_PAGE, createFtsTable, indexRecord, deleteRecord as ftsDeleteRecord, deleteByPrefix as ftsDeleteByPrefix, search as ftsSearch } from '@recued/fts';
import type { BlobStore } from './blob-store.js';

/** Hard ceiling on a single value's serialized size, in bytes. Values
 *  larger than this are rejected with `value_too_large`. Matches spec
 *  §5 and the kernel ingredient's error surface. */
export const MAX_VALUE_BYTES = 10 * 1024 * 1024;

/** Inline / blob split. Values ≤ this byte count are stored inline;
 *  larger ones are pushed to the BlobStore. */
export const INLINE_CUTOFF_BYTES = 64 * 1024;

/** Compare-and-set is intentionally inline-only. Preparing a content-addressed
 *  blob before the SQLite revision check would let every stale conflict strand
 *  unaccounted bytes. D-200 state rows are compact and fit under this bound. */
export const COMPARE_AND_SET_MAX_VALUE_BYTES = INLINE_CUTOFF_BYTES;

/** Maximum allowed key length. */
export const MAX_KEY_LENGTH = 512;

export interface SharedRecord {
  key: string;
  value: unknown;
  /** Store-owned revision token. Null means a legacy last-writer-wins row;
   * callers must not infer CAS control from value.revision. */
  cas_revision: number | null;
  size_bytes: number;
  author_id: string;
  recipe_id: string | null;
  written_at: number;
  last_read_at: number | null;
}

export interface SharedListRow {
  key: string;
  value: unknown;
}

export interface SharedSearchRow {
  key: string;
  value: unknown;
  rank: number;
}

export interface WriteOptions {
  author_id: string;
  recipe_id?: string | null;
}

export type SharedExpectedRevision = number | null;

export interface SharedCompareAndSetResult {
  bytes: number;
  revision: number;
  created: boolean;
}

export interface SharedStore {
  write(key: string, value: unknown, opts: WriteOptions): Promise<{ bytes: number }>;
  /** Atomically create or advance one revision-controlled row.
   *
   *  `expectedRevision: null` is create-if-absent and requires
   *  `value.revision === 0`. A numeric expectation requires an existing
   *  compare-and-set-controlled row at exactly that revision and a next value at
   *  `expectedRevision + 1`. Once created this way, ordinary `write` cannot
   *  overwrite the row and bypass the compare-and-set boundary. */
  compareAndSet(
    key: string,
    expectedRevision: SharedExpectedRevision,
    value: unknown,
    opts: WriteOptions,
  ): Promise<SharedCompareAndSetResult>;
  read(key: string): Promise<SharedRecord | null>;
  /** `''` lists the whole durable tier (what the rpc's `data.shared.` root
   *  browse strips to). Any other prefix is exact-or-descendant; a trailing
   *  dot means descendants only. */
  list(prefix: string): Promise<SharedListRow[]>;
  search(scope: string, query: string, limit?: number): Promise<SharedSearchRow[]>;
  /** Deletes a legacy LWW row; revision-controlled rows conflict closed. */
  delete(key: string): Promise<boolean>;
  /** All-or-nothing when the namespace contains a revision-controlled row. */
  deleteByPrefix(prefix: string): Promise<number>;
  totalBytes(): number;
  close(): void;
}

const FTS_TABLE = 'shared_store_fts';
const TABLE = 'shared_store';
const PROTECT_REVISION_CONTROLLED_DELETE_TRIGGER =
  'shared_store_protect_revision_controlled_delete';

export const ensureSharedSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      key          TEXT PRIMARY KEY,
      value_inline TEXT,
      blob_hash    TEXT,
      size_bytes   INTEGER NOT NULL,
      author_id    TEXT NOT NULL,
      recipe_id    TEXT,
      written_at   INTEGER NOT NULL,
      last_read_at INTEGER,
      cas_revision INTEGER CHECK (cas_revision IS NULL OR cas_revision >= 0)
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
    CREATE INDEX IF NOT EXISTS shared_store_blob_hash_idx
      ON ${TABLE} (blob_hash) WHERE blob_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS shared_store_prefix_idx ON ${TABLE} (key);
  `);
  // D-200 Slice 1 — databases created before the compare-and-set substrate do
  // not have the revision token. Use schema inspection rather than swallowing
  // every ALTER error, so an actual migration failure remains visible.
  const columns = db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'cas_revision')) {
    db.exec(
      `ALTER TABLE ${TABLE}
       ADD COLUMN cas_revision INTEGER CHECK (cas_revision IS NULL OR cas_revision >= 0)`,
    );
  }
  // One-time rebuild when the stored FTS text's format changes — see
  // `FTS_CONTENT_FORMAT`. Format 2 space-separates unspaced scripts so a
  // 2-character CJK / Thai term matches as an adjacent phrase.
  //
  // ⛔ THIS STORE NEEDED IT TO AVOID A REGRESSION, not just to gain the fix.
  // Writes now go in segmented; leaving old rows verbatim would strand them
  // where even the run-INITIAL matches they used to serve stop working, because
  // the query side is segmented too. Indexing only inline values mirrors the
  // write path exactly — a CAS-spilled value is not in the index there either.
  createFtsTable(db, FTS_TABLE, {
    reindex: () => {
      // ⛔ PAGED, NOT `.iterate()` — better-sqlite3 refuses a write while a read
      // statement is iterating, and this loop writes per row. See the note in
      // `collections/table.ts`; the failure is silent and empties the index.
      const page = db.prepare(
        `SELECT key, value_inline FROM ${TABLE} `
        + `WHERE value_inline IS NOT NULL AND key > ? ORDER BY key LIMIT ?`,
      );
      let after = '';
      for (;;) {
        const rows = page.all(after, FTS_REINDEX_PAGE) as
          Array<{ key: string; value_inline: string }>;
        if (rows.length === 0) break;
        for (const row of rows) indexRecord(db, FTS_TABLE, row.key, row.value_inline);
        after = rows[rows.length - 1].key;
      }
    },
  });
  // A compare-and-set row cannot be deleted and recreated at revision 0 through
  // the ordinary shared mutation surface. The store methods preflight this for
  // typed errors; the trigger is the final statement-atomic guard for prefix
  // deletes and any future direct DELETE path.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${PROTECT_REVISION_CONTROLLED_DELETE_TRIGGER}
    BEFORE DELETE ON ${TABLE}
    WHEN OLD.cas_revision IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'shared_compare_and_set_required');
    END;
  `);
};

export class SharedKeyInvalidError extends Error {
  constructor(reason: string) {
    super(`shared_key_invalid: ${reason}`);
    this.name = 'SharedKeyInvalidError';
  }
}

export class ValueTooLargeError extends Error {
  constructor(size: number) {
    super(`value_too_large: serialized ${size} bytes exceeds ${MAX_VALUE_BYTES}`);
    this.name = 'ValueTooLargeError';
  }
}

export class SharedValueSerializationError extends Error {
  constructor(reason: string) {
    super(`shared_value_invalid: ${reason}`);
    this.name = 'SharedValueSerializationError';
  }
}

export class SubkeyWriteError extends Error {
  constructor(key: string, conflictingKey: string) {
    super(`shared_key_invalid: cannot write subkey '${key}' while '${conflictingKey}' already exists`);
    this.name = 'SubkeyWriteError';
  }
}

export class SharedCompareAndSetValidationError extends Error {
  constructor(reason: string) {
    super(`shared_compare_and_set_invalid: ${reason}`);
    this.name = 'SharedCompareAndSetValidationError';
  }
}

export class SharedCompareAndSetValueTooLargeError extends Error {
  constructor(public readonly size: number) {
    super(
      `shared_compare_and_set_value_too_large: serialized ${size} bytes exceeds the ${COMPARE_AND_SET_MAX_VALUE_BYTES}-byte inline limit`,
    );
    this.name = 'SharedCompareAndSetValueTooLargeError';
  }
}

export class SharedCompareAndSetConflictError extends Error {
  constructor(
    public readonly key: string,
    public readonly expectedRevision: SharedExpectedRevision,
    public readonly actualRevision: number | null,
    public readonly found: boolean,
  ) {
    const actual = found
      ? (actualRevision === null ? 'not revision-controlled' : `revision ${actualRevision}`)
      : 'missing';
    super(
      `shared_compare_and_set_conflict: key '${key}' expected ${
        expectedRevision === null ? 'absence' : `revision ${expectedRevision}`
      }, found ${actual}`,
    );
    this.name = 'SharedCompareAndSetConflictError';
  }
}

export type SharedRevisionControlledMutation = 'write' | 'delete' | 'delete-prefix';

export class SharedCompareAndSetRequiredError extends Error {
  constructor(
    public readonly key: string,
    public readonly operation: SharedRevisionControlledMutation = 'write',
  ) {
    super(
      `shared_compare_and_set_required: ${operation} cannot mutate revision-controlled key '${key}'`,
    );
    this.name = 'SharedCompareAndSetRequiredError';
  }
}

export const assertValidKey = (key: string): void => {
  if (typeof key !== 'string' || key.length === 0) {
    throw new SharedKeyInvalidError('key must be a non-empty string');
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new SharedKeyInvalidError(`key exceeds ${MAX_KEY_LENGTH} chars`);
  }
  if (key.startsWith('.') || key.endsWith('.') || key.includes('..')) {
    throw new SharedKeyInvalidError('key must not start/end with "." or contain ".."');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(key)) {
    throw new SharedKeyInvalidError('key contains invalid characters (allowed: [A-Za-z0-9._-])');
  }
};

/** Namespace operations conventionally spell a prefix with a trailing dot
 *  (`data.shared.recipe.<bundle>.active.`). Stored keys still may not end in a
 *  dot, so normalize exactly that delimiter before applying the store's
 *  segment-safe exact-or-descendant match. */
const normalizeNamespacePrefix = (
  prefix: string,
): { key: string; descendantsOnly: boolean } => {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new SharedKeyInvalidError('key must be a non-empty string');
  }
  if (prefix.length > MAX_KEY_LENGTH) {
    throw new SharedKeyInvalidError(`key exceeds ${MAX_KEY_LENGTH} chars`);
  }
  const descendantsOnly = prefix.endsWith('.');
  const normalized = descendantsOnly ? prefix.slice(0, -1) : prefix;
  assertValidKey(normalized);
  return { key: normalized, descendantsOnly };
};

export interface CreateSharedStoreOptions {
  db: Database.Database;
  blobs: BlobStore;
  /** Time source for `written_at` / `last_read_at`. */
  now?: () => number;
  /** Phase B gate hook. Every write / delete / deleteByPrefix reports
   *  the signed byte delta so the shared_store gate stays aligned with
   *  the live `SUM(size_bytes)` total. Exceptions thrown by the sink
   *  are swallowed so a misbehaving gate never breaks a write. */
  onBytesChanged?: (delta: number) => void;
}

export const createSharedStore = (opts: CreateSharedStoreOptions): SharedStore => {
  const { db, blobs } = opts;
  const now = opts.now ?? (() => Date.now());
  const onBytesChanged = opts.onBytesChanged;

  const reportDelta = (delta: number): void => {
    if (onBytesChanged && delta !== 0) {
      try {
        onBytesChanged(delta);
      } catch (_err) {
        // never break writes on gate-sink failure
      }
    }
  };

  ensureSharedSchema(db);

  const writeStmt = db.prepare(
    `INSERT INTO ${TABLE}
       (key, value_inline, blob_hash, size_bytes, author_id, recipe_id,
        written_at, last_read_at, cas_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(key) DO UPDATE SET
       value_inline = excluded.value_inline,
       blob_hash = excluded.blob_hash,
       size_bytes = excluded.size_bytes,
       author_id = excluded.author_id,
       recipe_id = excluded.recipe_id,
       written_at = excluded.written_at
     WHERE ${TABLE}.cas_revision IS NULL`,
  );

  const compareAndSetCreateStmt = db.prepare(
    `INSERT INTO ${TABLE}
       (key, value_inline, blob_hash, size_bytes, author_id, recipe_id,
        written_at, last_read_at, cas_revision)
     VALUES
       (@key, @value_inline, @blob_hash, @size_bytes, @author_id, @recipe_id,
        @written_at, NULL, @revision)
     ON CONFLICT(key) DO NOTHING`,
  );

  const compareAndSetUpdateStmt = db.prepare(
    `UPDATE ${TABLE}
        SET value_inline = @value_inline,
            blob_hash = @blob_hash,
            size_bytes = @size_bytes,
            author_id = @author_id,
            recipe_id = @recipe_id,
            written_at = @written_at,
            cas_revision = @revision
      WHERE key = @key AND cas_revision = @expected_revision`,
  );

  const compareAndSetStateStmt = db.prepare(
    `SELECT size_bytes, cas_revision FROM ${TABLE} WHERE key = ?`,
  );

  const readStmt = db.prepare(
    `SELECT key, value_inline, blob_hash, size_bytes, author_id, recipe_id, written_at, last_read_at, cas_revision
     FROM ${TABLE} WHERE key = ?`,
  );

  const touchStmt = db.prepare(
    `UPDATE ${TABLE} SET last_read_at = ? WHERE key = ?`,
  );

  // ⛔ RANGE, not `LIKE … ESCAPE`. The escaping was here for a real reason —
  // a key may contain `_` (a LIKE single-char wildcard, allowed by
  // `assertValidKey`), and on the DELETE path "a bare `_` would otherwise
  // delete rows the caller never named". A half-open range has NO wildcard
  // semantics, so that hazard stops existing rather than being escaped.
  //
  // It is also ~92x faster. SQLite cannot apply its LIKE-prefix optimisation
  // to a BOUND pattern, so every one of these planned as
  // `SCAN … USING COVERING INDEX shared_store_prefix_idx` — O(total keys) on a
  // table of user data. Measured at 100k rows: 2.075ms → 0.023ms, same 200
  // rows returned. See `prefix-range.ts`.
  const listStmt = db.prepare(
    `SELECT key, value_inline, blob_hash FROM ${TABLE}
     WHERE key = ? OR (key >= ? AND key < ?)
     ORDER BY key`,
  );

  const listDescendantsStmt = db.prepare(
    `SELECT key, value_inline, blob_hash FROM ${TABLE}
     WHERE key >= ? AND key < ?
     ORDER BY key`,
  );

  // The whole durable tier, for the root browse (`list('')`). No range at all
  // — a root prefix has no upper bound to compute.
  const listAllStmt = db.prepare(
    `SELECT key, value_inline, blob_hash FROM ${TABLE} ORDER BY key`,
  );

  const deleteStmt = db.prepare(`DELETE FROM ${TABLE} WHERE key = ?`);

  const deleteByPrefixStmt = db.prepare(
    `DELETE FROM ${TABLE} WHERE key = ? OR (key >= ? AND key < ?)`,
  );

  const deleteDescendantsStmt = db.prepare(
    `DELETE FROM ${TABLE} WHERE key >= ? AND key < ?`,
  );

  const totalBytesStmt = db.prepare(
    `SELECT COALESCE(SUM(size_bytes), 0) AS total FROM ${TABLE}`,
  );

  // Subkey-write guard: reject writing `deal.123.stage` when
  // `deal.123` already exists. Implemented as a scan on each write —
  // keys are capped at 512 chars so the check is cheap.
  const findConflictingAncestor = (key: string): string | null => {
    const parts = key.split('.');
    for (let i = parts.length - 1; i > 0; i--) {
      const ancestor = parts.slice(0, i).join('.');
      const row = db
        .prepare(`SELECT 1 FROM ${TABLE} WHERE key = ? LIMIT 1`)
        .get(ancestor);
      if (row) return ancestor;
    }
    return null;
  };

  const resolveValue = async (inline: string | null, blobHash: string | null): Promise<unknown> => {
    if (inline !== null) {
      try { return JSON.parse(inline); } catch { return inline; }
    }
    if (blobHash !== null) {
      const buf = await blobs.get(blobHash);
      if (!buf) return null;
      try { return JSON.parse(buf.toString('utf8')); } catch { return buf.toString('utf8'); }
    }
    return null;
  };

  const serializeValue = (
    value: unknown,
  ): { serialized: string; bytes: number } => {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value ?? null);
    } catch {
      throw new SharedValueSerializationError('value must be JSON-serializable');
    }
    if (serialized === undefined) {
      throw new SharedValueSerializationError('value must serialize to a JSON value');
    }
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_VALUE_BYTES) throw new ValueTooLargeError(bytes);
    return { serialized, bytes };
  };

  const encodeSerializedValue = async (
    serialized: string,
    bytes: number,
  ): Promise<{
    inline: string | null;
    blobHash: string | null;
  }> => {
    if (bytes <= INLINE_CUTOFF_BYTES) {
      return { inline: serialized, blobHash: null };
    }
    const blobHash = await blobs.put(Buffer.from(serialized, 'utf8'));
    return { inline: null, blobHash };
  };

  const assertCompareAndSetJsonValue = (
    value: unknown,
    path = 'value',
    ancestors: WeakSet<object> = new WeakSet<object>(),
    depth = 0,
  ): void => {
    if (
      value === null
      || typeof value === 'string'
      || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
    ) {
      return;
    }
    if (typeof value !== 'object') {
      throw new SharedCompareAndSetValidationError(`${path} must contain only JSON data`);
    }
    if (depth >= 64) {
      throw new SharedCompareAndSetValidationError(`${path} exceeds the maximum nesting depth`);
    }
    if (ancestors.has(value)) {
      throw new SharedCompareAndSetValidationError(`${path} must not contain a cycle`);
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            throw new SharedCompareAndSetValidationError(
              `${path}[${index}] must be an own enumerable data property`,
            );
          }
          assertCompareAndSetJsonValue(
            descriptor.value,
            `${path}[${index}]`,
            ancestors,
            depth + 1,
          );
        }
        for (const key of Reflect.ownKeys(value)) {
          if (key === 'length') continue;
          if (
            typeof key !== 'string'
            || !/^(?:0|[1-9][0-9]*)$/u.test(key)
            || Number(key) >= value.length
          ) {
            throw new SharedCompareAndSetValidationError(
              `${path} arrays must not carry non-index properties`,
            );
          }
        }
        return;
      }

      const prototype = Object.getPrototypeOf(value) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new SharedCompareAndSetValidationError(`${path} must be a plain object`);
      }
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') {
          throw new SharedCompareAndSetValidationError(`${path} must not contain symbol keys`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new SharedCompareAndSetValidationError(
            `${path}.${key} must be an own enumerable data property`,
          );
        }
        assertCompareAndSetJsonValue(
          descriptor.value,
          `${path}.${key}`,
          ancestors,
          depth + 1,
        );
      }
    } catch (error) {
      if (error instanceof SharedCompareAndSetValidationError) throw error;
      throw new SharedCompareAndSetValidationError(`${path} could not be inspected safely`);
    } finally {
      ancestors.delete(value);
    }
  };

  const nextRevisionFor = (
    expectedRevision: SharedExpectedRevision,
    value: unknown,
  ): number => {
    if (
      expectedRevision !== null
      && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    ) {
      throw new SharedCompareAndSetValidationError(
        'expected_revision must be null or a non-negative safe integer',
      );
    }
    assertCompareAndSetJsonValue(value);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new SharedCompareAndSetValidationError('value must be an object with revision');
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, 'revision');
    } catch {
      throw new SharedCompareAndSetValidationError('value.revision could not be inspected');
    }
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new SharedCompareAndSetValidationError(
        'value.revision must be an own enumerable data property',
      );
    }
    const revision = descriptor.value;
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new SharedCompareAndSetValidationError(
        'value.revision must be a non-negative safe integer',
      );
    }
    if (expectedRevision === Number.MAX_SAFE_INTEGER) {
      throw new SharedCompareAndSetValidationError('expected_revision cannot advance safely');
    }
    const required = expectedRevision === null ? 0 : expectedRevision + 1;
    if (revision !== required) {
      throw new SharedCompareAndSetValidationError(
        `value.revision must equal ${required} for the supplied expectation`,
      );
    }
    return revision;
  };

  const assertSerializedRevision = (serialized: string, revision: number): void => {
    let stored: unknown;
    try {
      stored = JSON.parse(serialized);
    } catch {
      throw new SharedCompareAndSetValidationError('serialized value is not valid JSON');
    }
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
      throw new SharedCompareAndSetValidationError(
        'serialized value must remain an object with revision',
      );
    }
    const storedRevision = Object.getOwnPropertyDescriptor(stored, 'revision')?.value;
    if (storedRevision !== revision) {
      throw new SharedCompareAndSetValidationError(
        'serialized value.revision must match the validated revision',
      );
    }
  };

  const updateSearchIndex = (
    key: string,
    serialized: string,
    inline: string | null,
  ): void => {
    // Full-text indexing is inline-only. Large compare-and-set records use the
    // same documented limit as ordinary shared writes.
    if (inline !== null) {
      indexRecord(db, FTS_TABLE, key, serialized);
    } else {
      ftsDeleteRecord(db, FTS_TABLE, key);
    }
  };

  return {
    async write(key, value, options) {
      assertValidKey(key);
      const ancestor = findConflictingAncestor(key);
      if (ancestor) throw new SubkeyWriteError(key, ancestor);

      const controlled = compareAndSetStateStmt.get(key) as
        | { size_bytes: number; cas_revision: number | null }
        | undefined;
      if (controlled && controlled.cas_revision !== null) {
        throw new SharedCompareAndSetRequiredError(key);
      }
      const { serialized, bytes } = serializeValue(value);
      const { inline, blobHash } = await encodeSerializedValue(serialized, bytes);

      const priorRow = db
        .prepare(`SELECT size_bytes FROM ${TABLE} WHERE key = ?`)
        .get(key) as { size_bytes: number } | undefined;
      const prev = priorRow?.size_bytes ?? 0;

      const result = writeStmt.run(
        key,
        inline,
        blobHash,
        bytes,
        options.author_id,
        options.recipe_id ?? null,
        now(),
      );
      if (result.changes === 0) {
        throw new SharedCompareAndSetRequiredError(key);
      }

      updateSearchIndex(key, serialized, inline);

      reportDelta(bytes - prev);
      return { bytes };
    },

    async compareAndSet(key, expectedRevision, value, options) {
      assertValidKey(key);
      const revision = nextRevisionFor(expectedRevision, value);
      const { serialized, bytes } = serializeValue(value);
      if (bytes > COMPARE_AND_SET_MAX_VALUE_BYTES) {
        throw new SharedCompareAndSetValueTooLargeError(bytes);
      }
      const inline = serialized;
      const blobHash = null;
      // A custom `toJSON` must not validate one revision and persist another.
      // The store-owned token and the JSON row must always agree byte-for-byte.
      assertSerializedRevision(serialized, revision);

      const apply = db.transaction((): { created: boolean; previousBytes: number } => {
        const ancestor = findConflictingAncestor(key);
        if (ancestor) throw new SubkeyWriteError(key, ancestor);

        const before = compareAndSetStateStmt.get(key) as
          | { size_bytes: number; cas_revision: number | null }
          | undefined;
        const params = {
          key,
          value_inline: inline,
          blob_hash: blobHash,
          size_bytes: bytes,
          author_id: options.author_id,
          recipe_id: options.recipe_id ?? null,
          written_at: now(),
          revision,
          expected_revision: expectedRevision,
        };

        const result = expectedRevision === null
          ? compareAndSetCreateStmt.run(params)
          : compareAndSetUpdateStmt.run(params);
        if (result.changes === 0) {
          const current = compareAndSetStateStmt.get(key) as
            | { size_bytes: number; cas_revision: number | null }
            | undefined;
          throw new SharedCompareAndSetConflictError(
            key,
            expectedRevision,
            current?.cas_revision ?? null,
            current !== undefined,
          );
        }

        updateSearchIndex(key, serialized, inline);
        return { created: before === undefined, previousBytes: before?.size_bytes ?? 0 };
      });

      // BEGIN IMMEDIATE acquires the SQLite writer reservation before the
      // read/check/write block. The conditional INSERT/UPDATE is still the
      // final guard, while the immediate transaction keeps FTS and byte-delta
      // bookkeeping on the same committed snapshot across DB connections.
      const result = apply.immediate();
      reportDelta(bytes - result.previousBytes);
      return { bytes, revision, created: result.created };
    },

    async read(key) {
      assertValidKey(key);
      const row = readStmt.get(key) as
        | undefined
        | {
            key: string;
            value_inline: string | null;
            blob_hash: string | null;
            size_bytes: number;
            author_id: string;
            recipe_id: string | null;
            written_at: number;
            last_read_at: number | null;
            cas_revision: number | null;
          };
      if (!row) return null;
      const value = await resolveValue(row.value_inline, row.blob_hash);
      touchStmt.run(now(), key);
      return {
        key: row.key,
        value,
        cas_revision: row.cas_revision,
        size_bytes: row.size_bytes,
        author_id: row.author_id,
        recipe_id: row.recipe_id,
        written_at: row.written_at,
        last_read_at: row.last_read_at,
      };
    },

    async list(prefix) {
      // ⛔ THE WHOLE-TIER BROWSE IS SPELLED `''`, AND IT IS LIST-ONLY.
      // `shared.list({ prefix: 'data.shared.' })` — the Data → Storage tab's
      // root browse — strips the whole `data.shared.` prefix at the rpc
      // boundary and arrives here as the empty string, which
      // `normalizeNamespacePrefix` rejects with `key must be a non-empty
      // string`. That error was the ONLY thing that tab ever rendered.
      //
      // ⚠ `deleteByPrefix` deliberately does NOT get this branch: it keeps
      // going through `normalizeNamespacePrefix`, so no caller can wipe the
      // durable tier by handing it a root prefix. Read-widening and
      // delete-widening are separate decisions; only the read is widened here.
      //
      // ⚠ `search` is the third sibling and is NOT fixed here: an empty scope
      // reaches `@recued/fts` as a literal `key = ''` match (whole-tier there
      // is spelled `'*'`, and `shared.search` cannot express it — `scope:
      // 'data.shared.*'` is rejected by the rpc, `scope: 'data.shared.'`
      // returns zero matches). Verified, not assumed. It fails SILENTLY, so it
      // has no visible surface today; fixing it changes recipe-facing FTS
      // reach and is its own decision.
      if (prefix === '') {
        const rows = listAllStmt.all() as Array<{
          key: string;
          value_inline: string | null;
          blob_hash: string | null;
        }>;
        const all: SharedListRow[] = [];
        for (const row of rows) {
          all.push({ key: row.key, value: await resolveValue(row.value_inline, row.blob_hash) });
        }
        return all;
      }
      const { key: normalizedPrefix, descendantsOnly } = normalizeNamespacePrefix(prefix);
      // The descendant set is exactly the keys starting with `<prefix>.` — a
      // half-open range over that, rather than a LIKE pattern.
      const lo = `${normalizedPrefix}.`;
      const hi = prefixUpperBound(lo);
      if (hi === null) return [];
      const rows = (descendantsOnly
        ? listDescendantsStmt.all(lo, hi)
        : listStmt.all(normalizedPrefix, lo, hi)) as Array<{
        key: string;
        value_inline: string | null;
        blob_hash: string | null;
      }>;
      const out: SharedListRow[] = [];
      for (const row of rows) {
        out.push({ key: row.key, value: await resolveValue(row.value_inline, row.blob_hash) });
      }
      return out;
    },

    async search(scope, query, limit) {
      if (scope.length > 0 && scope !== '*') assertValidScopeForSearch(scope);
      const results = ftsSearch(db, FTS_TABLE, { scope, query, limit });
      if (results.length === 0) return [];
      // Hydrate each match by fetching the stored JSON. Inline-only per
      // FTS limit — blob-backed records never appear here.
      const hydrateStmt = db.prepare(
        `SELECT value_inline FROM ${TABLE} WHERE key = ?`,
      );
      const out: SharedSearchRow[] = [];
      for (const r of results) {
        const row = hydrateStmt.get(r.key) as { value_inline: string | null } | undefined;
        // Skip a ghost FTS hit with no surviving main-table row rather than
        // emitting a null-valued match (mirrors annotation-store).
        if (!row) continue;
        const inline = row.value_inline;
        let value: unknown = null;
        if (inline !== null) {
          try { value = JSON.parse(inline); } catch { value = inline; }
        }
        out.push({ key: r.key, value, rank: r.rank });
      }
      return out;
    },

    async delete(key) {
      assertValidKey(key);
      const apply = db.transaction(() => {
        const row = db
          .prepare(`SELECT size_bytes, cas_revision FROM ${TABLE} WHERE key = ?`)
          .get(key) as
            | { size_bytes: number; cas_revision: number | null }
            | undefined;
        if (!row) return null;
        if (row.cas_revision !== null) {
          throw new SharedCompareAndSetRequiredError(key, 'delete');
        }
        deleteStmt.run(key);
        ftsDeleteRecord(db, FTS_TABLE, key);
        return row;
      });
      const row = apply.immediate();
      if (!row) return false;
      // Main-table + FTS deletion commit together. Do NOT unlink `blob_hash`
      // here: the root is content-addressed and shared with sibling
      // shared-store rows and annotations, so another live row may reference
      // the same bytes. The reference-aware shared-store orphan sweep reclaims
      // the physical blob after the last SQL reference disappears.
      reportDelta(-row.size_bytes);
      return true;
    },

    async deleteByPrefix(prefix) {
      const { key: normalizedPrefix, descendantsOnly } = normalizeNamespacePrefix(prefix);
      const lo = `${normalizedPrefix}.`;
      const hi = prefixUpperBound(lo);
      if (hi === null) return 0;
      const apply = db.transaction(() => {
        const rows = (descendantsOnly
          ? db
            .prepare(
              `SELECT key, size_bytes, cas_revision
                 FROM ${TABLE} WHERE key >= ? AND key < ?
                 ORDER BY key`,
            )
            .all(lo, hi)
          : db
            .prepare(
              `SELECT key, size_bytes, cas_revision
                 FROM ${TABLE} WHERE key = ? OR (key >= ? AND key < ?)
                 ORDER BY key`,
            )
            .all(normalizedPrefix, lo, hi)) as Array<{
              key: string;
              size_bytes: number;
              cas_revision: number | null;
            }>;
        const protectedRow = rows.find((row) => row.cas_revision !== null);
        if (protectedRow) {
          throw new SharedCompareAndSetRequiredError(protectedRow.key, 'delete-prefix');
        }

        const result = descendantsOnly
          ? deleteDescendantsStmt.run(lo, hi)
          : deleteByPrefixStmt.run(normalizedPrefix, lo, hi);
        if (descendantsOnly) {
          for (const row of rows) ftsDeleteRecord(db, FTS_TABLE, row.key);
        } else {
          ftsDeleteByPrefix(db, FTS_TABLE, normalizedPrefix);
        }
        return {
          changes: result.changes,
          freed: rows.reduce((total, row) => total + row.size_bytes, 0),
        };
      });
      const result = apply.immediate();
      reportDelta(-result.freed);
      // As with exact delete, leave content-addressed bytes to the combined
      // shared + annotation reference-aware orphan sweep. Directly unlinking a
      // hash here would corrupt any surviving row that deduplicated to it.
      return result.changes;
    },

    totalBytes() {
      const row = totalBytesStmt.get() as { total: number };
      return row.total;
    },

    close() { /* no-op — prepared statements finalize with the db close */ },
  };
};

const assertValidScopeForSearch = (scope: string): void => {
  // Scope accepts `prefix.*` or an exact key; both are just stricter
  // forms of a valid key string. Strip the trailing `.*` before
  // validating.
  const base = scope.endsWith('.*') ? scope.slice(0, -2) : scope;
  assertValidKey(base);
};

/** Every distinct `blob_hash` referenced by a row in the `shared_store`
 *  table. Used by the Phase B eviction cascade's orphan blob sweep to
 *  build the keep-set before deleting unreferenced blobs. */
export const listSharedReferencedBlobHashes = (
  db: Database.Database,
): Set<string> => {
  const rows = db
    .prepare(`SELECT DISTINCT blob_hash FROM ${TABLE} WHERE blob_hash IS NOT NULL`)
    .all() as Array<{ blob_hash: string }>;
  return new Set(rows.map((r) => r.blob_hash));
};
