/** The archive preview's row count reports what it could NOT count.
 *
 *  `record_count` is rendered to an operator twice — the Settings restore
 *  preview ("1,234 records from <date>") and the restore-onboarding splash
 *  ("1,234 records across N tables") — and the contract calls it "total
 *  record count across every table in the archive". The walk skips a table
 *  it cannot read, which is correct (one bad table must not fail a dry run)
 *  but used to be SILENT: `tables` simply lacked the key, which is
 *  indistinguishable from a table the archive never had, so the number
 *  stayed a total in the reader's eyes while being short by an unknown
 *  amount — on the screen where they decide to commit a restore.
 *
 *  ⚠ Driven through `countTablesFromProbe` rather than a real archive on
 *  purpose. Export takes a `VACUUM INTO` snapshot, and a database corrupt
 *  enough to have an uncountable table does not survive that rebuild — so
 *  there is no way to reach this branch end-to-end, and a test that pretended
 *  to would be exercising something else. The seam exists so the branch is
 *  reachable at all. */

import { describe, expect, it } from 'vitest';

import {
  countTablesFromProbe,
  type RowCountProbe,
} from '../archive/archive-runtime.js';

/** A probe over a fixed table list; any table in `unreadable` throws on
 *  COUNT, the way SQLite does for a table it cannot open. */
const probeOf = (
  counts: Record<string, number>,
  unreadable: string[] = [],
): RowCountProbe => ({
  prepare(sql: string) {
    if (sql.includes('sqlite_master')) {
      const names = Object.keys(counts).map((name) => ({ name }));
      return { all: () => names, get: () => names[0] };
    }
    const hit = Object.keys(counts).find((name) => sql.includes(`"${name}"`) || sql.includes(name));
    if (hit !== undefined && unreadable.includes(hit)) {
      return {
        all: () => { throw new Error(`SQLITE_CORRUPT: no such table: ${hit}`); },
        get: () => { throw new Error(`SQLITE_CORRUPT: no such table: ${hit}`); },
      };
    }
    return { all: () => [], get: () => ({ n: hit === undefined ? 0 : counts[hit] }) };
  },
});

describe('archive preview row count', () => {
  it('counts every table and reports nothing uncounted on a healthy db', () => {
    const out = countTablesFromProbe(probeOf({ example: 3, schedules: 2 }));
    expect(out.record_count).toBe(5);
    expect(out.tables).toEqual({ example: 3, schedules: 2 });
    expect(out.uncounted).toEqual([]);
  });

  it('names the table it could not count instead of dropping it', () => {
    const out = countTablesFromProbe(probeOf({ example: 3, broken: 99 }, ['broken']));
    // Still returns — a dry run must not die on one bad table …
    expect(out.record_count).toBe(3);
    // … but the omission is REPORTED, not inferred from a missing key.
    expect(out.uncounted).toEqual(['broken']);
    // ⛔ And the skipped table must not appear with a made-up number: a `0`
    // here would read as "this table is empty", which is a different claim
    // and a worse one than "we could not count it".
    expect(Object.hasOwn(out.tables, 'broken')).toBe(false);
  });

  it('keeps counting after a failure — one bad table does not truncate the walk', () => {
    // The catch must not abort the loop: the tables AFTER the bad one are
    // exactly the rows a short-circuit would silently drop.
    const out = countTablesFromProbe(
      probeOf({ first: 1, broken: 99, last: 4 }, ['broken']),
    );
    expect(out.record_count).toBe(5);
    expect(out.tables).toEqual({ first: 1, last: 4 });
    expect(out.uncounted).toEqual(['broken']);
  });

  it('reports every uncounted table, not just the first', () => {
    const out = countTablesFromProbe(
      probeOf({ a: 1, b: 2, c: 3 }, ['b', 'c']),
    );
    expect(out.record_count).toBe(1);
    expect(out.uncounted).toEqual(['b', 'c']);
  });

  it('an empty database is complete, not unknown', () => {
    const out = countTablesFromProbe(probeOf({}));
    expect(out).toEqual({ record_count: 0, tables: {}, uncounted: [] });
  });
});
