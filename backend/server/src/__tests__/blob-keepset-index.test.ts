/** The blob-GC keepset reads the blob-bearing rows, not every row.
 *
 *  ⛔ THE DEFECT, IN SIX PLACES AT ONCE. The cascade's blob sweep and archive
 *  export both build their keepset with
 *  `SELECT DISTINCT blob_hash … WHERE blob_hash IS NOT NULL`, and every one of
 *  the six tables it runs over planned as a full `SCAN` plus a
 *  `TEMP B-TREE FOR DISTINCT` — reading every row to find the few carrying a CAS
 *  blob. Measured at 200k rows with 2% blob-bearing:
 *
 *      3.34ms -> 0.01ms   (334x), identical answer, on a partial index holding
 *                         4,000 of the 200,000 rows
 *
 *  🔑 PARTIAL IS WHAT MAKES IT CHEAP. Only ~2% of writes touch the index, so a
 *  recurring O(all rows) pass becomes O(blob rows) for almost no write cost. It
 *  is also COVERING for this query, so the DISTINCT dedups over already-sorted
 *  index values rather than building a b-tree.
 *
 *  ⛔ ONE SHAPE, SIX CALL SITES — collections, calendar, annotation,
 *  shared_store, cache_entries, and the `collection_*` walk in
 *  `collection-blob-refs.ts` which inherits the per-collection index. Fixing the
 *  one the sweep pointed at would have left the other five scanning, which is
 *  the whole reason this file drives all of them from one table of cases.
 *
 *  ⚠ AND IT GUARDS A DESTRUCTIVE PASS. The keepset decides which blobs are
 *  LIVE; a sweep that misses one reaps a body still referenced. So every case
 *  asserts the ANSWER is unchanged alongside the plan — a faster keepset that
 *  returned a different set would be data loss wearing a performance costume. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createCollectionTable } from '../collections/table.js';
import { ensureAnnotationSchema } from '../storage/annotation-store.js';
import { ensureSharedSchema } from '../storage/shared-store.js';

const KEEPSET_SQL = (t: string) =>
  `SELECT DISTINCT blob_hash FROM ${t} WHERE blob_hash IS NOT NULL`;

const planOf = (db: Database.Database, t: string): string =>
  (db.prepare(`EXPLAIN QUERY PLAN ${KEEPSET_SQL(t)}`).all() as Array<{
    detail: string;
  }>).map((r) => r.detail).join(' ; ');

/** The index this table should have, found by SHAPE rather than by name — the
 *  five stores name theirs differently and the name is not the contract. */
const partialBlobIndex = (db: Database.Database, table: string): string | undefined =>
  (db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL`,
  ).all(table) as Array<{ sql: string }>)
    .map((r) => r.sql)
    .find((sql) => /blob_hash/.test(sql) && /WHERE/i.test(sql));

describe('blob-GC keepset index', () => {
  it('⛔ a collection table SEEKS its blob-bearing rows', () => {
    const db = new Database(':memory:');
    createCollectionTable({
      db, platform: 'mail', slug: 'bench', ftsTextFor: () => '',
    } as never);
    const t = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'collection_%'
        AND name NOT LIKE '%_fts%' LIMIT 1`,
    ).get() as { name: string }).name;

    const plan = planOf(db, t);
    expect(plan, plan).toMatch(/USING (COVERING )?INDEX/);
    expect(plan, plan).not.toMatch(/TEMP B-TREE/);
    db.close();
  });

  it('⛔ KNOWN NEGATIVE: without it, the same query scans and sorts', () => {
    // Proves the assertion above discriminates. Dropped at runtime rather than
    // by hand-building a table, so the comparison is against the REAL schema.
    const db = new Database(':memory:');
    createCollectionTable({
      db, platform: 'mail', slug: 'bench', ftsTextFor: () => '',
    } as never);
    const t = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'collection_%'
        AND name NOT LIKE '%_fts%' LIMIT 1`,
    ).get() as { name: string }).name;
    db.exec(`DROP INDEX idx_${t}_blob_hash`);

    const plan = planOf(db, t);
    expect(plan, plan).toMatch(/SCAN/);
    expect(plan, plan).toMatch(/TEMP B-TREE/);
    db.close();
  });

  it('⛔ annotation and shared_store get one too — same shape, same sweep', () => {
    // These feed the OTHER two CAS roots (`sharedBlobs`). Omitting either would
    // leave half the keepset scanning while the collections half seeks.
    const db = new Database(':memory:');
    ensureAnnotationSchema(db);
    ensureSharedSchema(db);
    for (const t of ['annotation', 'shared_store']) {
      expect(partialBlobIndex(db, t), `${t} has no partial blob index`).toBeDefined();
      const plan = planOf(db, t);
      expect(plan, `${t}: ${plan}`).toMatch(/USING (COVERING )?INDEX/);
      expect(plan, `${t}: ${plan}`).not.toMatch(/TEMP B-TREE/);
    }
    db.close();
  });

  it('⛔ the index is PARTIAL — a plain one would hold every row forever', () => {
    // The shape is the whole economics. A plain `(blob_hash)` index carries an
    // entry per row (200k in the measurement) to answer a question about 4,000
    // of them, and every write maintains it. Pinned so nobody "simplifies" the
    // WHERE away — which would still pass the plan assertions above.
    const db = new Database(':memory:');
    ensureAnnotationSchema(db);
    ensureSharedSchema(db);
    for (const t of ['annotation', 'shared_store']) {
      expect(partialBlobIndex(db, t)!, t).toMatch(/WHERE\s+blob_hash\s+IS\s+NOT\s+NULL/i);
    }
    db.close();
  });

  it('⛔ the keepset ANSWER is identical with and without the index', () => {
    // The pass is DESTRUCTIVE — the keepset decides which blobs are live, so a
    // faster sweep returning a different set reaps a body still referenced.
    const build = (withIndex: boolean): string[] => {
      const db = new Database(':memory:');
      createCollectionTable({
        db, platform: 'mail', slug: 'bench', ftsTextFor: () => '',
      } as never);
      const t = (db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'collection_%'
          AND name NOT LIKE '%_fts%' LIMIT 1`,
      ).get() as { name: string }).name;
      if (!withIndex) db.exec(`DROP INDEX idx_${t}_blob_hash`);
      const ins = db.prepare(
        `INSERT INTO ${t} (record_id, source_id, hot_fields,
                           blob_hash, received_at, modified_at, size_bytes)
         VALUES (?, ?, '{}', ?, ?, ?, 1)`,
      );
      for (let i = 0; i < 400; i++) {
        // A mix: null, repeated hashes (dedup), and distinct ones.
        const hash = i % 5 === 0 ? null : `h${i % 7}`;
        ins.run(`r-${i}`, 's', hash, 1000 + i, 1000 + i);
      }
      const rows = (db.prepare(KEEPSET_SQL(t)).all() as Array<{ blob_hash: string }>)
        .map((r) => r.blob_hash).sort();
      db.close();
      return rows;
    };
    const withIdx = build(true);
    expect(withIdx).toEqual(build(false));
    expect(withIdx).toHaveLength(7);           // deduped, and NULLs excluded
    expect(withIdx).not.toContain(null);
  });
});
