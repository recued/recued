/** `countByAddress` seeks instead of scanning the whole collection.
 *
 *  ⛔ THE DEFECT. The query bound its JSON path — `json_extract(hot_fields, ?)`
 *  — which reads as tidy and is UNINDEXABLE BY CONSTRUCTION: a bound path
 *  differs per call, so no expression index can ever cover it. Every count was
 *  a full scan.
 *
 *  ⚠ AND ITS ONE CALLER IS ON A USER-VISIBLE LATENCY PATH. `countFrom` backs
 *  the chat short-circuit for "how many emails from <Name>?", which answers
 *  WITHOUT an LLM call — over `collection.mail`, which D-230 sized to 2 GB.
 *  Measured at 300k rows / 112 MB: 63.6ms → 0.004ms.
 *
 *  ⛔ BOTH HALVES ARE LOAD-BEARING, and only a plan assertion can tell. The
 *  literal path WITHOUT the index still scanned (71.9ms); the index without
 *  the literal path could never be matched. A result assertion passes in all
 *  four combinations — the count was always correct, it was just expensive. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createCollectionTable } from '../collections/table.js';

/** ⛔ RECORDS THE SQL THE PRODUCT ACTUALLY PREPARES.
 *
 *  The first version of the two plan tests wrote the SQL out by hand — literal
 *  path in one, bound path in the other — and EXPLAINed that. Which proves what
 *  SQLite does with SQL THE TEST wrote, and nothing about what `countByAddress`
 *  prepares. A mutation reverting the statement to the bound path passed all
 *  six tests: the suite could not see the defect it exists for.
 *
 *  Spying on `db.prepare` and EXPLAINing the recorded text closes that: the
 *  statement under test is the one the collection built. */
const mk = (rows = 200) => {
  const db = new Database(':memory:');
  const prepared: string[] = [];
  const realPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    prepared.push(sql);
    return realPrepare(sql);
  };
  const table = createCollectionTable({
    db, platform: 'mail', slug: 'bench', ftsTextFor: () => '',
  } as never);
  for (let i = 0; i < rows; i++) {
    // ⚠ Fields taken from `CollectionRecord`, not written from memory — a
    // guessed shape (no `source_id`) failed the NOT NULL constraint and read
    // like the index change had broken inserts.
    table.upsert({
      record_id: `m-${i}`,
      source_id: `src-${i}`,
      hot_fields: { from: `Sender${i % 20}@Example.COM`, subject: `s${i}` },
      received_at: 1_000 + i,
      modified_at: 1_000 + i,
      size_bytes: 100,
    } as never);
  }
  return { db, table, prepared };
};

/** The count statement the collection prepared, found by shape rather than by
 *  index — the prepare order is not a contract. */
const countSql = (prepared: readonly string[]): string => {
  const hit = prepared.filter(
    (sql) => /COUNT\(\*\)/i.test(sql) && /hot_fields/i.test(sql),
  );
  if (hit.length !== 1) {
    throw new Error(`expected exactly one count-by-address statement, got ${hit.length}`);
  }
  return hit[0]!;
};

/** The table name `createCollectionTable` derives — needed to read the plan. */
const tableName = (db: Database.Database): string =>
  (db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'collection_%'
      AND name NOT LIKE '%_fts%' LIMIT 1`,
  ).get() as { name: string }).name;

describe('countByAddress', () => {
  it('⛔ SEEKS via the address index once the collection opts in', () => {
    const { db, table, prepared } = mk();
    table.ensureAddressIndex('from');
    table.countByAddress('from', 'sender1@example.com'); // forces the prepare
    const t = tableName(db);
    const sql = countSql(prepared);

    // ⚠ EXPLAINing the RECORDED statement, not one written here. A bound path
    // would show up as a SCAN even with the index present.
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('x') as Array<{
      detail: string;
    }>).map((r) => r.detail).join(' ; ');
    expect(plan, sql).toMatch(new RegExp(`SEARCH ${t} USING (COVERING )?INDEX`));
    expect(plan, sql).not.toMatch(new RegExp(`SCAN ${t}`));
    db.close();
  });

  it('⛔ the prepared statement INTERPOLATES the json path, never binds it', () => {
    // The shape is the whole fix: a bound path differs per call, so no
    // expression index can ever cover it. Pinned so nobody "simplifies" the
    // per-field cache back to one static statement — which is tidier code and
    // a guaranteed scan.
    const { db, table, prepared } = mk();
    table.countByAddress('from', 'sender1@example.com');
    const sql = countSql(prepared);

    expect(sql).toContain("json_extract(hot_fields, '$.from')");
    expect(sql).not.toMatch(/json_extract\(\s*hot_fields\s*,\s*\?/);
    db.close();
  });

  it('counts the same rows it always did, case- and space-folded', () => {
    // Equivalence: the fix moves the plan, never the answer. Addresses are
    // seeded mixed-case with a trailing space to exercise LOWER + TRIM.
    const { db, table } = mk();
    table.ensureAddressIndex('from');
    expect(table.countByAddress('from', 'sender3@example.com')).toBe(10);
    expect(table.countByAddress('from', '  SENDER3@EXAMPLE.COM  ')).toBe(10);
    expect(table.countByAddress('from', 'nobody@example.com')).toBe(0);
    db.close();
  });

  it('is identical with and without the index — only the plan moves', () => {
    const withIdx = mk();
    withIdx.table.ensureAddressIndex('from');
    const without = mk();
    for (const addr of ['sender0@example.com', 'sender19@example.com', 'x@y.z']) {
      expect(withIdx.table.countByAddress('from', addr))
        .toBe(without.table.countByAddress('from', addr));
    }
    withIdx.db.close();
    without.db.close();
  });

  it('⛔ the index is OPT-IN — a collection that never asks does not pay', () => {
    // The expression only makes sense where the hot field exists. Creating it
    // on every table would make every unrelated collection write maintain an
    // index nothing queries.
    const { db } = mk(10);
    const t = tableName(db);
    const idx = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name = ?`,
    ).get(`idx_${t}_addr_from`);
    expect(idx).toBeUndefined();
    db.close();
  });

  it('⛔ findByHotFieldIn SEEKS too — same shape, exact-match index', () => {
    // The sibling defect: `findByHotFieldIn` also bound its path, and its
    // comment cited `countByAddress` as precedent for doing so. It has NO
    // LIMIT and runs over `collection.mail`, so every mail-twin join scanned
    // the mailbox.
    const { db, table, prepared } = mk();
    table.ensureHotFieldIndex('rfc_message_id');
    table.findByHotFieldIn('rfc_message_id', ['<a@x>', '<b@x>']);
    const t = tableName(db);
    const sql = prepared.find(
      (q) => /IN \(/.test(q) && /hot_fields/.test(q) && !/COUNT/i.test(q),
    )!;
    expect(sql).toContain("json_extract(hot_fields, '$.rfc_message_id')");
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('a', 'b') as Array<{
      detail: string;
    }>).map((r) => r.detail).join(' ; ');
    expect(plan, sql).toMatch(new RegExp(`SEARCH ${t} USING (COVERING )?INDEX`));
    db.close();
  });

  it('⛔ the two indexes are DISTINCT — folded vs exact cannot share one', () => {
    // `ensureAddressIndex` indexes LOWER(TRIM(...)) because addresses fold;
    // `ensureHotFieldIndex` indexes the bare extract because Message-IDs are
    // case-sensitive. SQLite matches expression indexes syntactically, so one
    // index would silently serve NEITHER query.
    const { db, table } = mk(10);
    table.ensureAddressIndex('from');
    table.ensureHotFieldIndex('from');
    const t = tableName(db);
    const defs = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='index' AND name LIKE ?`,
    ).all(`idx_${t}_%_from`) as Array<{ sql: string }>).map((r) => r.sql);
    expect(defs).toHaveLength(2);
    expect(defs.some((d) => /LOWER\(TRIM/.test(d))).toBe(true);
    expect(defs.some((d) => !/LOWER\(TRIM/.test(d))).toBe(true);
    db.close();
  });

  it('rejects a field name that is not a clean identifier', () => {
    // It is INTERPOLATED into the SQL text now, not bound — the validation is
    // load-bearing rather than hygiene.
    const { db, table } = mk(5);
    expect(() => table.ensureAddressIndex('from; DROP TABLE x--')).toThrow(/invalid/i);
    expect(() => table.countByAddress('a b', 'x')).toThrow(/invalid/i);
    db.close();
  });
});
