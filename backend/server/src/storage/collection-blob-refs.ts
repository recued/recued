/** Collection CAS blob-reference reader.
 *
 *  Every warehouse `collection_*` table (mail / calendar / file / webhook
 *  bodies) keeps a `blob_hash` column pointing at a CAS object in the
 *  encrypted `cache_blobs` root (collections reuse the cache blob store).
 *  Both the archive export (which bundles referenced blobs) and the eviction
 *  cascade's orphan sweep (which keeps referenced blobs) need the union of
 *  those hashes across every collection table — so the scan lives here, in one
 *  place, consumed by both. */

import type Database from 'better-sqlite3';

/** Quote a SQLite identifier (table/column name), escaping embedded
 *  double-quotes. Collection table names come from `sqlite_master` — for an
 *  import that's an attacker-supplyable archive — so any name interpolated
 *  into SQL must be quoted to avoid a malformed/injected statement. */
export const quoteSqliteIdent = (name: string): string =>
  `"${name.replace(/"/g, '""')}"`;

/** Union of every CAS blob hash referenced by any `collection_*` table's
 *  `blob_hash` column. Returns an empty set when no collection tables exist.
 *
 *  FAIL-CLOSED (like the sibling cache / shared / annotation readers, which all
 *  throw on error). This is deliberate: the eviction cascade consumes this set
 *  to decide which blobs to KEEP during a destructive orphan sweep, so a
 *  silently-incomplete set would reap LIVE collection bodies. A transient db
 *  error (SQLITE_BUSY / I/O — most likely exactly when the cascade runs, under
 *  storage pressure) therefore PROPAGATES → the sweep aborts with zero
 *  deletions rather than sweeping against a partial keepset.
 *
 *  Not every `collection_*` table carries a `blob_hash` column — e.g.
 *  `collection_instances` and `collection_file_inbound_storage_refs` do not.
 *  Those are skipped via a STRUCTURAL column probe (bound parameter, no
 *  interpolation), NOT by swallowing the resulting "no such column" — so a
 *  genuine transient error on a real body table is never mistaken for a missing
 *  column. The archive's best-effort `collectBlobHashesByStore` opts into
 *  leniency by wrapping this call in its own try/catch; the cascade calls it
 *  unguarded. */
export const listCollectionReferencedBlobHashes = (
  db: Database.Database,
): Set<string> => {
  const hashes = new Set<string>();
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'collection_%'`,
    )
    .all() as Array<{ name: string }>;
  const hasBlobHash = db.prepare(
    `SELECT 1 FROM pragma_table_info(?) WHERE name = 'blob_hash' LIMIT 1`,
  );
  for (const { name } of tables) {
    // Structural skip: a collection_* table with no blob_hash column holds no
    // CAS references (it is not a body table). Probe the column instead of
    // catching the query error, so transient errors still surface.
    if (!hasBlobHash.get(name)) continue;
    const rows = db
      .prepare(
        `SELECT DISTINCT blob_hash FROM ${quoteSqliteIdent(name)} WHERE blob_hash IS NOT NULL`,
      )
      .all() as Array<{ blob_hash: string }>;
    for (const r of rows) if (r.blob_hash) hashes.add(r.blob_hash);
  }
  return hashes;
};
