/** `prefixUpperBound` and the range predicates built on it.
 *
 *  This backs a DELETE path over user data (`shared_store`,
 *  `data.shared.delete-prefix`) and the generic `Collection.deleteByPrefix`.
 *  A wrong upper bound either misses rows (silent under-delete, looks like the
 *  data is still there) or over-reaches (silent over-delete, looks like data
 *  loss with no error anywhere). Both are quiet, so the boundaries are pinned
 *  individually rather than by a single round-trip.
 *
 *  ⛔ THE RANGE IS NOT MERELY EQUIVALENT TO THE OLD `LIKE` — IT IS STRICTER.
 *  `LIKE` treats `_` and `%` in the caller's prefix as wildcards.
 *  `shared-store` escaped them (its comment: "a bare `_` would otherwise delete
 *  rows the caller never named"); the generic `sqlite-collection` did NOT. The
 *  divergence tests below assert the range does the right thing where the
 *  unescaped `LIKE` did the wrong thing — that is the bug being closed, so it
 *  is asserted as a difference, not as a round-trip. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { prefixUpperBound } from '../storage/prefix-range.js';
import { createSQLiteCollection } from '../sqlite-collection.js';

describe('prefixUpperBound', () => {
  it('increments the last code point', () => {
    expect(prefixUpperBound('a')).toBe('b');
    expect(prefixUpperBound('ns7.')).toBe('ns7/'); // '.' 0x2E -> '/' 0x2F
    expect(prefixUpperBound('abc')).toBe('abd');
  });

  it('returns null where no upper bound exists', () => {
    // Empty prefix matches EVERYTHING — there is no bound, and inventing one
    // would silently truncate the result set.
    expect(prefixUpperBound('')).toBeNull();
    expect(prefixUpperBound(String.fromCodePoint(0x10ffff))).toBeNull();
  });

  it('carries when the last code point is the maximum', () => {
    expect(prefixUpperBound(`a${String.fromCodePoint(0x10ffff)}`)).toBe('b');
  });

  it('steps over the surrogate range', () => {
    // U+D7FF + 1 is U+D800, an unpaired surrogate — not a valid scalar value
    // and not a boundary any real key sorts against.
    expect(prefixUpperBound('퟿')).toBe('');
  });

  it('handles astral-plane code points as single units', () => {
    // '😀' is one code point but TWO UTF-16 units. Incrementing the trailing
    // low surrogate instead of the code point would produce a bound that sorts
    // wrong under BINARY collation.
    expect(prefixUpperBound('x😀')).toBe(`x${String.fromCodePoint(0x1f601)}`);
  });
});

describe('the range predicate over a real table', () => {
  const seed = (keys: readonly string[]): Database.Database => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (key TEXT PRIMARY KEY, data TEXT NOT NULL)');
    const ins = db.prepare('INSERT INTO t (key, data) VALUES (?, ?)');
    for (const k of keys) ins.run(k, '{}');
    return db;
  };

  const rangeKeys = (db: Database.Database, prefix: string): string[] => {
    const hi = prefixUpperBound(prefix);
    const rows = (hi === null
      ? db.prepare('SELECT key FROM t ORDER BY key').all()
      : db.prepare('SELECT key FROM t WHERE key >= ? AND key < ? ORDER BY key').all(prefix, hi)
    ) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  };

  it('matches exactly the keys that start with the prefix', () => {
    const db = seed(['a', 'ab', 'abc', 'abd', 'b', 'ac', 'aB']);
    expect(rangeKeys(db, 'ab')).toEqual(['ab', 'abc', 'abd']);
    // The prefix itself is included; a sibling that merely sorts nearby is not.
    expect(rangeKeys(db, 'ac')).toEqual(['ac']);
    db.close();
  });

  it('⛔ does NOT treat `_` in the prefix as a wildcard — the old LIKE did', () => {
    const db = seed(['my_recipe::a', 'myXrecipe::a', 'my_recipe::b']);
    // The bug: `key LIKE 'my_recipe::' || '%'` matches `myXrecipe::a` too,
    // because `_` is LIKE's single-character wildcard. On `deleteByPrefix`
    // that is an over-delete of a row the caller never named.
    const viaLike = (db
      .prepare(`SELECT key FROM t WHERE key LIKE ? || '%' ORDER BY key`)
      .all('my_recipe::') as Array<{ key: string }>).map((r) => r.key);
    expect(viaLike).toContain('myXrecipe::a'); // the defect, demonstrated

    expect(rangeKeys(db, 'my_recipe::')).toEqual(['my_recipe::a', 'my_recipe::b']);
    db.close();
  });

  it('⛔ does NOT treat `%` in the prefix as a wildcard either', () => {
    const db = seed(['100%.x', '100pct.x', '100%.y']);
    expect(rangeKeys(db, '100%.')).toEqual(['100%.x', '100%.y']);
    db.close();
  });

  it('an empty prefix matches everything rather than nothing', () => {
    const db = seed(['a', 'b', 'c']);
    expect(rangeKeys(db, '')).toEqual(['a', 'b', 'c']);
    db.close();
  });

  it('SEARCHes the index instead of scanning', () => {
    // The performance half. `LIKE` with a BOUND pattern cannot use the index —
    // SQLite plans it as a SCAN whatever indexes exist, which is why this is a
    // range and not an escaped LIKE. A correct answer read the slow way is
    // still the bug.
    const db = seed(['a']);
    db.exec('CREATE INDEX t_key ON t(key)');
    const plan = (sql: string, ...p: unknown[]): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p) as Array<{ detail: string }>)
        .map((r) => r.detail).join(' ; ');
    expect(plan('SELECT key FROM t WHERE key >= ? AND key < ?', 'a', 'b'))
      .toMatch(/SEARCH/);
    expect(plan(`SELECT key FROM t WHERE key LIKE ? || '%'`, 'a'))
      .toMatch(/SCAN/);
    db.close();
  });
});

describe('cache invalidation by prefix', () => {
  // Reachable from the `cache.invalidate(prefix)` rpc. Cache keys carry recipe
  // ids and ingredient slugs, so an underscore in a prefix is ordinary here.
  const mkCache = (): Database.Database => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE cache_entries (
      key TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL)`);
    const ins = db.prepare('INSERT INTO cache_entries (key,size_bytes) VALUES (?,?)');
    for (const k of ['a_b::1', 'aXb::1', 'a_b::2', 'other']) ins.run(k, 10);
    return db;
  };

  it('⛔ the SELECT and the DELETE agree row-for-row', () => {
    // They feed byte accounting: the SELECT sums what is about to go, the
    // DELETE removes it. Two different predicates over the same prefix is how
    // a storage gate ends up believing in bytes that are already gone.
    const db = mkCache();
    const upper = prefixUpperBound('a_b::');
    const selected = (db
      .prepare('SELECT key FROM cache_entries WHERE key >= ? AND key < ?')
      .all('a_b::', upper) as Array<{ key: string }>).map((r) => r.key).sort();
    const deleted = db
      .prepare('DELETE FROM cache_entries WHERE key >= ? AND key < ?')
      .run('a_b::', upper).changes;
    expect(selected).toEqual(['a_b::1', 'a_b::2']);
    expect(deleted).toBe(selected.length);
    // The sibling an unescaped LIKE would have invalidated too.
    expect(db.prepare(`SELECT COUNT(*) c FROM cache_entries WHERE key = 'aXb::1'`)
      .get()).toEqual({ c: 1 });
    db.close();
  });
});

describe('Collection.listByPrefix / deleteByPrefix over the range', () => {
  const mk = (): { db: Database.Database; c: ReturnType<typeof createSQLiteCollection<{ v: number }>> } => {
    const db = new Database(':memory:');
    return { db, c: createSQLiteCollection<{ v: number }>(db, 'items') };
  };

  it('lists and deletes exactly the prefixed keys', async () => {
    const { db, c } = mk();
    for (const k of ['x.1', 'x.2', 'y.1', 'x', 'xz.1']) await c.set(k, { v: 1 });
    expect((await c.listByPrefix('x.')).map((e) => e.key).sort()).toEqual(['x.1', 'x.2']);
    expect(await c.deleteByPrefix('x.')).toBe(2);
    expect((await c.listKeys()).sort()).toEqual(['x', 'xz.1', 'y.1']);
    db.close();
  });

  it('⛔ an underscore in the prefix no longer over-deletes', async () => {
    const { db, c } = mk();
    for (const k of ['a_b::1', 'aXb::1', 'a_b::2']) await c.set(k, { v: 1 });
    expect(await c.deleteByPrefix('a_b::')).toBe(2);
    // The sibling the unescaped LIKE would have taken with it.
    expect(await c.has('aXb::1')).toBe(true);
    db.close();
  });

  it('an empty prefix still means "everything"', async () => {
    const { db, c } = mk();
    for (const k of ['a', 'b']) await c.set(k, { v: 1 });
    expect((await c.listByPrefix('')).length).toBe(2);
    expect(await c.deleteByPrefix('')).toBe(2);
    expect(await c.size()).toBe(0);
    db.close();
  });
});
