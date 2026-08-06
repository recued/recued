/** SQLite-backed cache store for recued-server.
 *
 *  Implements the CacheStore contract from @recued/cache. Split storage:
 *    - Entries with serialized payload ≤ INLINE_THRESHOLD (64 KB): value
 *      lives inline in the SQLite row as JSON text.
 *    - Entries above threshold: value is written to the blob store
 *      keyed by content hash; the SQLite row holds only the hash ref.
 *
 *  Why split: SQLite handles small-row writes fast and the single-writer
 *  pattern avoids contention. Large BLOB writes in SQLite serialize
 *  behind small metadata writes and hurt throughput. The blob store
 *  is a separate async-I/O surface with natural dedup.
 *
 *  Schema (auto-created):
 *    CREATE TABLE cache_entries (
 *      key             TEXT PRIMARY KEY,
 *      inline_value    TEXT,           -- JSON text; NULL when blob_hash set
 *      blob_hash       TEXT,           -- SHA-256 hex; NULL when inline
 *      expires_at      INTEGER NOT NULL,
 *      recipe_id       TEXT NOT NULL,
 *      ingredient_slug TEXT NOT NULL,
 *      size_bytes      INTEGER NOT NULL,
 *      created_at      INTEGER NOT NULL,
 *      last_accessed_at INTEGER NOT NULL
 *    );
 *    CREATE INDEX cache_last_accessed ON cache_entries(last_accessed_at);
 *    CREATE INDEX cache_recipe_id     ON cache_entries(recipe_id);
 *    CREATE INDEX cache_expires_at    ON cache_entries(expires_at);
 */

import type Database from 'better-sqlite3';
import type { CacheEntry, CacheStore } from '@recued/cache';
import {
  encrypt, decrypt,
  encodeCiphertext, decodeCiphertext,
} from '@recued/crypto';
import type { BlobStore } from './blob-store.js';
import { prefixUpperBound } from './prefix-range.js';

/** 64 KB threshold. Values serialized larger than this go to the blob
 *  store; smaller stay inline. Chosen to keep SQLite rows small while
 *  avoiding filesystem overhead for typical ingredient responses. */
export const INLINE_THRESHOLD = 64 * 1024;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS cache_entries (
    key              TEXT PRIMARY KEY,
    inline_value     TEXT,
    blob_hash        TEXT,
    expires_at       INTEGER NOT NULL,
    recipe_id        TEXT NOT NULL,
    ingredient_slug  TEXT NOT NULL,
    size_bytes       INTEGER NOT NULL,
    created_at       INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL,
    category         TEXT,
    risk_tier        TEXT,
    inline_enc       INTEGER
  );
  CREATE INDEX IF NOT EXISTS cache_last_accessed ON cache_entries(last_accessed_at);
  CREATE INDEX IF NOT EXISTS cache_recipe_id     ON cache_entries(recipe_id);
  CREATE INDEX IF NOT EXISTS cache_created_at    ON cache_entries(created_at);
  -- The one hot predicate that had no index. The TTL sweep
  -- (housekeeping/tasks/cache-eviction-beyond-ttl.ts) runs on a cadence and
  -- filters WHERE expires_at < ?, so without this every sweep SCANNED the
  -- whole cache. It matters most in the case that happens most: a HEALTHY
  -- cache with nothing expired, where the sweep previously read every row to
  -- find none. Measured on a file-backed WAL db, nothing expired:
  --   5k rows 0.08ms -> 0.02ms | 50k 0.62ms -> 0.02ms | 200k 2.43ms -> 0.02ms
  -- flat, because the cost stops depending on the cache size.
  -- IF NOT EXISTS, inside SCHEMA which is exec'd on every store construction,
  -- so existing databases pick it up on the next boot without a migration.
  CREATE INDEX IF NOT EXISTS cache_expires_at     ON cache_entries(expires_at);
`;

// In-place migration for pre-phase-5 databases: add the new columns if missing.
const MIGRATE_ADD_CATEGORY_COLUMNS = `
  ALTER TABLE cache_entries ADD COLUMN category  TEXT;
  ALTER TABLE cache_entries ADD COLUMN risk_tier TEXT;
`;

interface Row {
  key: string;
  inline_value: string | null;
  blob_hash: string | null;
  expires_at: number;
  recipe_id: string;
  ingredient_slug: string;
  size_bytes: number;
  created_at: number;
  last_accessed_at: number;
  category: string | null;
  risk_tier: string | null;
  /** Self-describing inline-payload encryption flag: 1 = `inline_value`
   *  is AES-256-GCM ciphertext, 0 = plaintext JSON, NULL = blob-backed
   *  row (no inline payload) OR a pre-flag legacy row (cleared on the
   *  column-add migration, so never observed at runtime). Read decode
   *  branches on THIS, not on the store's current key availability —
   *  a plaintext row must never be `atob`-decoded as ciphertext just
   *  because a key happens to be present now. */
  inline_enc: number | null;
}

const requireKey = (provider?: () => Uint8Array | null): Uint8Array | null => {
  if (!provider) return null;
  const key = provider();
  if (!key) throw new Error('sqlite-cache-store: locked (no encryption key available)');
  return key;
};

const decodeInline = async (
  raw: string,
  encrypted: boolean,
  encryption: (() => Uint8Array | null) | undefined,
  aad: Uint8Array,
): Promise<unknown> => {
  if (!encrypted) return JSON.parse(raw);
  // Encrypted-flagged row: the key is mandatory. `requireKey` throws
  // 'locked' when the vault is sealed — a sealed vault genuinely cannot
  // read its own ciphertext, so that surfaces as a typed error rather
  // than an `atob` crash. A null return means no provider is wired at
  // all (a plaintext-mode store reading a ciphertext row — a config
  // mismatch); fail loudly rather than feed null into `decrypt`.
  const key = requireKey(encryption);
  if (!key) {
    throw new Error('sqlite-cache-store: encrypted row read without an encryption key provider');
  }
  const ct = decodeCiphertext(raw);
  const plaintextBytes = await decrypt(key, ct, aad);
  return JSON.parse(new TextDecoder().decode(plaintextBytes));
};

const encodeInline = async (
  value: unknown,
  key: Uint8Array | null,
  aad: Uint8Array,
): Promise<string> => {
  const serialized = JSON.stringify(value);
  if (!key) return serialized;
  const pt = new TextEncoder().encode(serialized);
  const ct = await encrypt(key, pt, aad);
  return encodeCiphertext(ct);
};

const rowToEntry = async (
  row: Row,
  blobs: BlobStore,
  encryption?: () => Uint8Array | null,
): Promise<CacheEntry> => {
  const aad = new TextEncoder().encode(row.key);

  let value: unknown;
  if (row.inline_value !== null) {
    // Decode is driven by the row's OWN self-describing `inline_enc`
    // flag, NOT the store's current key availability — a plaintext row
    // is JSON.parsed even when a key is present now, and the key is
    // acquired lazily only for a genuinely encrypted row.
    value = await decodeInline(row.inline_value, row.inline_enc === 1, encryption, aad);
  } else if (row.blob_hash !== null) {
    const buf = await blobs.get(row.blob_hash);
    value = buf ? JSON.parse(buf.toString('utf8')) : null;
  } else {
    value = null;
  }
  return {
    key: row.key,
    value,
    expires_at: row.expires_at,
    recipe_id: row.recipe_id,
    ingredient_slug: row.ingredient_slug,
    size_bytes: row.size_bytes,
    created_at: row.created_at,
    last_accessed_at: row.last_accessed_at,
    category: (row.category as CacheEntry['category']) ?? undefined,
    risk_tier: (row.risk_tier as CacheEntry['risk_tier']) ?? undefined,
  };
};

export interface SQLiteCacheStoreOptions {
  /** Entries above this byte size are offloaded to the blob store.
   *  Defaults to 64 KB. Exposed for tests. */
  inlineThreshold?: number;
  /** When provided, inline values are AES-256-GCM encrypted with AAD
   *  bound to the cache key. Blob-path values remain plaintext at this
   *  layer; the blob store applies its own encryption when configured
   *  with the same domain-separated sub-DEK.
   *  Returning null → locked; ops that read/write values throw.
   *  Metadata ops (size, evictLRU, deleteByRecipe) stay available even
   *  when locked. */
  getEncryptionKey?: () => Uint8Array | null;
  /** Phase B gate hook. When provided, the store reports every byte-
   *  count change (insert / overwrite / delete / LRU evict / clear)
   *  as a signed delta. Passed straight into `gate.addUsed(delta)` so
   *  the cache gate stays aligned with the live `size_bytes` total
   *  without the caller tracking per-write bytes. */
  onBytesChanged?: (delta: number) => void;
}

export const createSQLiteCacheStore = (
  db: Database.Database,
  blobs: BlobStore,
  options: SQLiteCacheStoreOptions = {},
): CacheStore => {
  db.exec(SCHEMA);
  // Schema migration for pre-phase-5 databases.
  const existingCols = db.prepare(`PRAGMA table_info(cache_entries)`).all() as { name: string }[];
  const colNames = new Set(existingCols.map(c => c.name));
  if (!colNames.has('category')) {
    db.exec(`ALTER TABLE cache_entries ADD COLUMN category TEXT`);
  }
  if (!colNames.has('risk_tier')) {
    db.exec(`ALTER TABLE cache_entries ADD COLUMN risk_tier TEXT`);
  }
  if (!colNames.has('inline_enc')) {
    db.exec(`ALTER TABLE cache_entries ADD COLUMN inline_enc INTEGER`);
    // Pre-flag rows carry no self-describing enc marker, so a mix of
    // plaintext + ciphertext rows (the compose-time snapshot-drift bug)
    // can't be safely disambiguated on read. The cache is regenerable
    // by definition (TTL'd ingredient/step results); flush it once on
    // the column add so every surviving row is self-describing. Orphaned
    // blobs are reaped by the regular sweep. (`feedback_pre_launch_no_migration`.)
    db.exec(`DELETE FROM cache_entries`);
  }

  const threshold = options.inlineThreshold ?? INLINE_THRESHOLD;
  const encryption = options.getEncryptionKey;
  const onBytesChanged = options.onBytesChanged;

  const reportDelta = (delta: number): void => {
    if (!onBytesChanged || delta === 0) return;
    try { onBytesChanged(delta); } catch { /* never break writes */ }
  };

  const getStmt = db.prepare(`SELECT * FROM cache_entries WHERE key = ?`);
  const sizeByKeyStmt = db.prepare(`SELECT size_bytes FROM cache_entries WHERE key = ?`);
  const deleteStmt = db.prepare(`DELETE FROM cache_entries WHERE key = ?`);
  const deleteByRecipeStmt = db.prepare(`DELETE FROM cache_entries WHERE recipe_id = ?`);
  const totalSizeStmt = db.prepare(`SELECT COALESCE(SUM(size_bytes), 0) as total FROM cache_entries`);
  const listForEvictStmt = db.prepare(`
    SELECT key, blob_hash, size_bytes FROM cache_entries
    ORDER BY last_accessed_at ASC
  `);
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO cache_entries
      (key, inline_value, blob_hash, expires_at, recipe_id, ingredient_slug, size_bytes, created_at, last_accessed_at, category, risk_tier, inline_enc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    async get(key) {
      const row = getStmt.get(key) as Row | undefined;
      if (!row) return null;
      return await rowToEntry(row, blobs, encryption);
    },

    async set(entry) {
      const serialized = JSON.stringify(entry.value);
      const byteLen = Buffer.byteLength(serialized, 'utf8');

      let inlineValue: string | null = null;
      let blobHash: string | null = null;
      // 1 = encrypted inline, 0 = plaintext inline, null = blob-backed.
      let inlineEnc: number | null = null;

      if (byteLen > threshold) {
        // Blob-path values: the blob store handles its own encryption +
        // locked-throw. A sealed vault (provider present, returns null)
        // throws here BEFORE the row is written — same posture as the
        // inline `requireKey` below, so neither path ever lands a
        // would-be-encrypted value as plaintext on disk.
        blobHash = await blobs.put(Buffer.from(serialized, 'utf8'));
      } else {
        // `requireKey` throws when a provider is wired but sealed
        // (locked / uninitialized); only a no-provider plaintext-mode
        // store returns null here → an `inline_enc=0` row.
        const key = requireKey(encryption);
        const aad = new TextEncoder().encode(entry.key);
        inlineValue = await encodeInline(entry.value, key, aad);
        inlineEnc = key ? 1 : 0;
      }

      // Capture the previous row's size (if any) so the gate delta
      // reports the net change on overwrite, not the whole entry.
      const priorRow = sizeByKeyStmt.get(entry.key) as { size_bytes: number } | undefined;
      const prev = priorRow?.size_bytes ?? 0;

      // If this key previously pointed at a different blob, we leave the
      // old blob to be reaped by the orphan sweep. The sweep is cheap and
      // handles the race where two keys briefly reference the same content.
      insertStmt.run(
        entry.key,
        inlineValue,
        blobHash,
        entry.expires_at,
        entry.recipe_id,
        entry.ingredient_slug,
        entry.size_bytes,
        entry.created_at,
        entry.last_accessed_at,
        entry.category ?? null,
        entry.risk_tier ?? null,
        inlineEnc,
      );
      reportDelta(entry.size_bytes - prev);
    },

    async delete(key) {
      const row = sizeByKeyStmt.get(key) as { size_bytes: number } | undefined;
      deleteStmt.run(key);
      if (row) reportDelta(-row.size_bytes);
      // Blob (if any) is eligible for orphan sweep; no synchronous unlink.
    },

    async deleteByRecipe(recipe_id) {
      const rows = db
        .prepare(`SELECT size_bytes FROM cache_entries WHERE recipe_id = ?`)
        .all(recipe_id) as Array<{ size_bytes: number }>;
      const freed = rows.reduce((sum, r) => sum + r.size_bytes, 0);
      deleteByRecipeStmt.run(recipe_id);
      reportDelta(-freed);
    },

    async deleteByPrefix(prefix) {
      // ⛔ RANGE, not `LIKE ? || '%'` — see `prefix-range.ts`. `LIKE` with a
      // bound pattern cannot use the index, and it treats `_` / `%` in the
      // caller's prefix as wildcards. This path is reachable from the
      // `cache.invalidate(prefix)` rpc, and cache keys carry recipe ids and
      // ingredient slugs, so an underscore here is ordinary rather than exotic.
      const upper = prefixUpperBound(prefix);
      const rows = (upper === null
        ? db.prepare(`SELECT size_bytes FROM cache_entries`).all()
        : db
          .prepare(`SELECT size_bytes FROM cache_entries WHERE key >= ? AND key < ?`)
          .all(prefix, upper)) as Array<{ size_bytes: number }>;
      const freed = rows.reduce((sum, r) => sum + r.size_bytes, 0);
      const changes = deleteCacheEntriesByPrefix(db, prefix);
      reportDelta(-freed);
      return changes;
    },

    async size() {
      const row = totalSizeStmt.get() as { total: number };
      return row.total;
    },

    async evictLRU(target_bytes) {
      const current = await this.size();
      if (current <= target_bytes) return;

      let freed = 0;
      const toFree = current - target_bytes;

      // ⛔ STREAM, don't materialise. `.all()` pulled EVERY cache row into JS
      // — key, blob_hash and size for the whole table — and then usually
      // deleted a handful and `break`ed. `ORDER BY last_accessed_at ASC` plans
      // as `SCAN … USING INDEX cache_last_accessed`, so rows already arrive in
      // order with no sort barrier, which means an iterator can stop as soon as
      // it has freed enough. Measured on a file-backed WAL db evicting ~10
      // rows: 5k rows 1.22ms → 0.07ms, 50k rows 19.75ms → 0.08ms (254x) — and
      // FLAT, because the cost is now the eviction, not the cache.
      //
      // ⚠ Keys are collected first and deleted after the loop. Deleting from a
      // table while a cursor is walking it is exactly the case SQLite leaves
      // unspecified ("a row that the query has not yet visited may or may not
      // appear"), and an LRU that skips rows evicts the wrong ones.
      const doomed: Array<{ key: string; size_bytes: number }> = [];
      for (const row of listForEvictStmt.iterate() as Iterable<{
        key: string; blob_hash: string | null; size_bytes: number;
      }>) {
        if (freed >= toFree) break;
        doomed.push({ key: row.key, size_bytes: row.size_bytes });
        freed += row.size_bytes;
      }
      // One transaction, not one implicit commit per row.
      db.transaction(() => {
        for (const row of doomed) deleteStmt.run(row.key);
      })();
      reportDelta(-freed);
    },

    async clear() {
      const { total } = totalSizeStmt.get() as { total: number };
      db.prepare(`DELETE FROM cache_entries`).run();
      reportDelta(-total);
    },

    async touch(key, at) {
      // One-row UPDATE — no blob rewrite, no row re-encoding, no
      // peer broadcast. Effectively "bump LRU".
      const expires = at.expires_at;
      if (expires !== undefined) {
        db.prepare(
          `UPDATE cache_entries SET last_accessed_at = ?, expires_at = ? WHERE key = ?`,
        ).run(at.last_accessed_at, expires, key);
      } else {
        db.prepare(
          `UPDATE cache_entries SET last_accessed_at = ? WHERE key = ?`,
        ).run(at.last_accessed_at, key);
      }
    },
  };
};

/** List all blob hashes currently referenced by cache rows. Used by
 *  the orphan sweep job to decide which blobs to keep. Exported
 *  separately since CacheStore's contract doesn't expose this. */
export const listReferencedBlobHashes = (db: Database.Database): Set<string> => {
  const stmt = db.prepare(`SELECT DISTINCT blob_hash FROM cache_entries WHERE blob_hash IS NOT NULL`);
  const rows = stmt.all() as { blob_hash: string }[];
  return new Set(rows.map(r => r.blob_hash));
};

/** List cache entries created strictly after `cursor` (peer's own
 *  created_at timestamp), ordered ascending, paginated. Backs the
 *  `cache.since(cursor)` rpc — reconnect reconciliation. */
export const listCacheEntriesSince = async (
  db: Database.Database,
  blobs: BlobStore,
  cursor: number,
  limit: number,
  encryption?: () => Uint8Array | null,
): Promise<{ entries: CacheEntry[]; next_cursor: number | null }> => {
  const stmt = db.prepare(`
    SELECT * FROM cache_entries
    WHERE created_at > ?
    ORDER BY created_at ASC
    LIMIT ?
  `);
  const rows = stmt.all(cursor, limit) as Row[];
  const entries = await Promise.all(rows.map(r => rowToEntry(r, blobs, encryption)));
  const next_cursor = entries.length === limit && entries.length > 0
    ? entries[entries.length - 1].created_at
    : null;
  return { entries, next_cursor };
};

/** Delete all cache entries whose key starts with the given prefix.
 *  Backs the `cache.invalidate(prefix)` rpc — event-driven invalidation
 *  cascades (warehouse event deletes matching cache rows in ext + server). */
export const deleteCacheEntriesByPrefix = (
  db: Database.Database,
  prefix: string,
): number => {
  // ⛔ RANGE — the `SELECT` in `deleteByPrefix` above MUST match this `DELETE`
  // row-for-row, or the byte accounting it feeds (`reportDelta`) drifts from
  // what was actually removed. Two different predicates over the same prefix is
  // how a storage gate ends up believing in bytes that are gone.
  const upper = prefixUpperBound(prefix);
  const result = upper === null
    ? db.prepare(`DELETE FROM cache_entries`).run()
    : db
      .prepare(`DELETE FROM cache_entries WHERE key >= ? AND key < ?`)
      .run(prefix, upper);
  return result.changes;
};
