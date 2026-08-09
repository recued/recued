/** The pinned-row count seeks instead of walking the whole author index.
 *
 *  ⛔ THE DEFECT. `countPinnedRows` asked
 *  `WHERE authored_by LIKE ?` with `'system.user_correction%'`. SQLite cannot
 *  apply its LIKE-prefix optimisation when the pattern is a BOUND PARAMETER, so
 *  this planned as `SCAN … USING COVERING INDEX` and walked the entire
 *  `idx_enrichment_authored_by` index on every call. Measured at 200k
 *  enrichment rows: **3.116ms -> 0.008ms (390x)**, returning the identical 400.
 *
 *  🔑 THE INDEX WAS ALREADY THERE. Only the predicate shape was wrong — the
 *  count was always correct, so nothing but a query plan could tell.
 *
 *  ⛔ AND THE FIX ALREADY EXISTED. `storage/prefix-range.ts` was written for
 *  exactly this, carries the 92x measurement from the earlier sweep, and is used
 *  by `sqlite-collection` / `shared-store` / `sqlite-cache-store`. This was a
 *  MISSED CALL SITE, not a new problem — which is why the sweep that found it
 *  also checked every other `LIKE ?` in the server rather than just this one.
 *
 *  ⚠ THE OTHERS ARE NOT DEFECTS, checked individually:
 *    - `hot_fields LIKE ?` in the housekeeping producers is a `%substring%`
 *      pre-narrow over JSON — no range expresses that;
 *    - `authored_by NOT LIKE ?` (registry-describe:168, vector-similarity:231)
 *      is a NEGATED prefix, i.e. the complement, which matches most rows and
 *      which no range can express;
 *    - `enrichment-store`'s `target_id LIKE ?` sites already SEEK, because
 *      `scope = ?` narrows first and the LIKE is a residual over that subset. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ENRICHMENT_PINNED_AUTHOR_PREFIX } from '@recued/contracts';

import { _testing as registryDescribeTesting } from '../mcp/registry-describe.js';
import { prefixUpperBound } from '../storage/prefix-range.js';

/** A `data_enrichment` table with the one column and index that matter here.
 *  Deliberately minimal: the point is the predicate shape against the real
 *  index expression, not the full enrichment schema. */
const world = (rows: readonly string[]) => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE data_enrichment (_id TEXT PRIMARY KEY, authored_by TEXT NOT NULL);
    CREATE INDEX idx_enrichment_authored_by ON data_enrichment (authored_by);
  `);
  const ins = db.prepare('INSERT INTO data_enrichment VALUES (?, ?)');
  rows.forEach((a, i) => ins.run(`e-${i}`, a));
  return db;
};

const LIKE_SQL = `SELECT COUNT(*) AS n FROM data_enrichment WHERE authored_by LIKE ?`;
const RANGE_SQL =
  `SELECT COUNT(*) AS n FROM data_enrichment WHERE authored_by >= ? AND authored_by < ?`;

const planOf = (db: Database.Database, sql: string, args: unknown[]): string =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args as never[]) as Array<{
    detail: string;
  }>).map((r) => r.detail).join(' ; ');

const PREFIX = ENRICHMENT_PINNED_AUTHOR_PREFIX;
const UPPER = prefixUpperBound(PREFIX)!;

describe('pinned-row count — the statement the PRODUCT prepares', () => {
  /** ⛔ EVERY OTHER CASE IN THIS FILE WRITES ITS OWN SQL, and would pass with
   *  the product reverted to `LIKE`. Verified: reverting `countPinnedRows` left
   *  all 14 existing registry-describe / enrichment-read tests green AND every
   *  hand-written case here. Only spying on `db.prepare` ties the assertions to
   *  the statement the product actually builds. */
  const drive = (rows: readonly string[]) => {
    const db = world(rows);
    const prepared: string[] = [];
    const real = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      prepared.push(sql);
      return real(sql);
    };
    const n = registryDescribeTesting.countPinnedRows(db);
    return { db, prepared, n };
  };

  it('⛔ prepares the RANGE form, never a bound LIKE', () => {
    const { db, prepared, n } = drive([`${PREFIX}.v1`, 'producer.a']);
    const sql = prepared.find((q) => /FROM data_enrichment/i.test(q))!;
    expect(sql, 'the product must not bind a LIKE pattern').not.toMatch(/LIKE/i);
    expect(sql).toMatch(/authored_by >= \? AND authored_by < \?/);
    expect(n).toBe(1);                       // ...and still counts correctly
    db.close();
  });

  it('⛔ that prepared statement SEEKS', () => {
    // The plan of the PRODUCT's statement, not of one written in this file.
    const { db, prepared } = drive([`${PREFIX}.v1`, 'producer.a']);
    const sql = prepared.find((q) => /FROM data_enrichment/i.test(q))!;
    const plan = planOf(db, sql, [PREFIX, UPPER]);
    expect(plan, sql).toMatch(/SEARCH .*USING (COVERING )?INDEX/);
    expect(plan, sql).not.toMatch(/^SCAN/);
    db.close();
  });

  it('counts through the product path across the boundary cases', () => {
    const { db, n } = drive([
      PREFIX, `${PREFIX}.v1`, `${PREFIX}zzz`,
      PREFIX.slice(0, -1), 'system.user_correctioo', 'producer.topic',
    ]);
    expect(n).toBe(3);
    db.close();
  });

  it('returns 0 with no db rather than throwing', () => {
    expect(registryDescribeTesting.countPinnedRows(undefined)).toBe(0);
  });
});

describe('pinned-row count', () => {
  it('⛔ the range form SEEKS', () => {
    const db = world([`${PREFIX}.v1`, 'producer.a', 'producer.b']);
    expect(planOf(db, RANGE_SQL, [PREFIX, UPPER]))
      .toMatch(/SEARCH .*USING (COVERING )?INDEX .*authored_by>\? AND authored_by<\?/);
    db.close();
  });

  it('⛔ KNOWN NEGATIVE: the LIKE form walks the whole index, same index present', () => {
    // Both forms use the SAME index and return the SAME number. Only the plan
    // separates them, which is the entire reason this file exists.
    const db = world([`${PREFIX}.v1`, 'producer.a']);
    const plan = planOf(db, LIKE_SQL, [`${PREFIX}%`]);
    expect(plan).toMatch(/SCAN .*USING (COVERING )?INDEX/);
    expect(plan).not.toMatch(/SEARCH/);
    db.close();
  });

  it('⛔ counts EXACTLY what LIKE counted, including the boundary cases', () => {
    // Equivalence is the whole risk of a prefix range: an off-by-one upper
    // bound silently drops or adds rows, and the count is used to SUBTRACT from
    // an agent-visible total — so a wrong answer inflates or hides rows rather
    // than erroring.
    const rows = [
      PREFIX,                        // the bare prefix — included
      `${PREFIX}.v1`,                // normal
      `${PREFIX}zzz`,                // still the prefix
      `${PREFIX.slice(0, -1)}`,      // one char short — excluded
      'system.user_correctioo',      // == the upper bound — EXCLUDED (half-open)
      'system.user_correctioz',      // past the bound — excluded
      'producer.topic',              // unrelated
    ];
    const db = world(rows);
    const like = (db.prepare(LIKE_SQL).get(`${PREFIX}%`) as { n: number }).n;
    const range = (db.prepare(RANGE_SQL).get(PREFIX, UPPER) as { n: number }).n;
    expect(range).toBe(like);
    expect(range).toBe(3);           // and it is the right number, not just equal
    db.close();
  });

  it('the upper bound increments the LAST code point only', () => {
    // Pins the boundary this depends on. `system.user_correction` ends in `n`,
    // so the exclusive bound is `…correctioo` — anything else silently changes
    // which rows are counted.
    expect(UPPER).toBe('system.user_correctioo');
    expect(UPPER.length).toBe(PREFIX.length);
  });

  it('⛔ a prefix with no upper bound is handled, not guessed', () => {
    // `prefixUpperBound` returns null for an empty prefix rather than
    // fabricating a bound, and the caller falls back to LIKE. A guessed bound
    // would be a silently truncated count.
    expect(prefixUpperBound('')).toBeNull();
  });

  it('⛔ the count now AGREES with the two startsWith checks — LIKE did not', () => {
    // ⛔ THIS IS A CORRECTNESS FIX, not only a speed one, and I only found it by
    // asking what the case difference actually meant.
    //
    // `LIKE` folds ASCII case; a BINARY range does not. Every OTHER "is this row
    // pinned?" test in the system is `String.startsWith`, which is
    // case-SENSITIVE — `enrichment-read.ts:191` (the read filter that hides the
    // row) and `:284` (the guard rejecting a caller who targets the prefix).
    // The old LIKE count was the lone case-INSENSITIVE one.
    //
    // So a row authored `SYSTEM.USER_CORRECTION.x` was SUBTRACTED from
    // `total_rows_visible` as pinned while the read filter still exposed it —
    // the total under-reported by exactly the rows the two checks disagreed on.
    // The write guard is case-sensitive too, so such a row is reachable rather
    // than hypothetical.
    const upper = `${PREFIX.toUpperCase()}.v1`;
    const db = world([`${PREFIX}.v1`, upper]);
    const like = (db.prepare(LIKE_SQL).get(`${PREFIX}%`) as { n: number }).n;
    const range = (db.prepare(RANGE_SQL).get(PREFIX, UPPER) as { n: number }).n;

    // What the rest of the system considers pinned:
    const bySiblingRule = [`${PREFIX}.v1`, upper]
      .filter((a) => a.startsWith(PREFIX)).length;
    expect(bySiblingRule).toBe(1);
    expect(range, 'the range agrees with startsWith').toBe(bySiblingRule);
    expect(like, 'LIKE did not').toBe(2);
    db.close();
  });
});
