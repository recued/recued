/** The key map beside each index: a write finds its key's row in a B-tree, never by scanning the index.
 *
 *  ⛔ Found 2026-11-19 (D-406's benchmark): `DELETE … WHERE key = ?` on `fts5(key UNINDEXED, …)` scanned the whole
 *  index on every write, so loading a mailbox of 250,000 slowed to about 90 ms a row by 185,000, and a purge paid one
 *  scan per record it removed. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  FTS_KEY_MAP_SUFFIX,
  appendRecord,
  createFtsTable,
  deleteByPrefix,
  deleteRecord,
  dropFtsTable,
  indexRecord,
  rebuildIndex,
  search,
} from '../index.js';

const NAME = 'notes_fts';
const MAP = `${NAME}${FTS_KEY_MAP_SUFFIX}`;
let db: Database.Database;

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => { db.close(); });

const mapRows = () => db.prepare(`SELECT key, rid FROM ${MAP} ORDER BY key`).all() as Array<{ key: string; rid: number }>;
const indexRows = () => db.prepare(`SELECT rowid AS rid, key FROM ${NAME} ORDER BY rowid`).all() as Array<{ rid: number; key: string | null }>;
const tableExists = (name: string) => db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(name) !== undefined;
const hits = (query: string) => search(db, NAME, { query }).map((row) => row.key).sort();

describe('the key map beside an index', () => {
  it('points each key at its row; a replace keeps that row, and a delete clears both', () => {
    createFtsTable(db, NAME);
    // Made on the first write, not with the table: a read-only connection never makes one.
    expect(tableExists(MAP)).toBe(false);
    indexRecord(db, NAME, 'a', 'apple');
    indexRecord(db, NAME, 'b', 'banana');
    expect(mapRows()).toEqual(indexRows().map(({ rid, key }) => ({ key, rid })));
    const before = mapRows();
    indexRecord(db, NAME, 'a', 'avocado');
    expect(mapRows()).toEqual(before);
    expect(indexRows()).toHaveLength(2);
    expect(hits('apple')).toEqual([]);
    expect(hits('avocado')).toEqual(['a']);
    deleteRecord(db, NAME, 'a');
    deleteRecord(db, NAME, 'never-there');
    expect(mapRows().map((row) => row.key)).toEqual(['b']);
    expect(indexRows().map((row) => row.key)).toEqual(['b']);
  });

  it('upgrades an index written before it: each key keeps its latest row, older ones go, a keyless row stays', () => {
    db.exec(`CREATE VIRTUAL TABLE ${NAME} USING fts5(key UNINDEXED, blob_text)`);
    const raw = db.prepare(`INSERT INTO ${NAME} (key, blob_text) VALUES (?, ?)`);
    raw.run('a', 'stale apple');
    raw.run('b', 'banana');
    raw.run('a', 'fresh apple');
    raw.run(null, 'orphan');
    expect(hits('apple')).toEqual(['a', 'a']);
    indexRecord(db, NAME, 'c', 'cherry');
    expect(mapRows().map((row) => row.key)).toEqual(['a', 'b', 'c']);
    expect(hits('apple')).toEqual(['a']);
    expect(hits('fresh')).toEqual(['a']);
    expect(hits('stale')).toEqual([]);
    expect(indexRows().filter((row) => row.key === null)).toHaveLength(1);
    // And from then on a replace finds the upgraded row.
    indexRecord(db, NAME, 'a', 'apricot');
    expect(hits('apple')).toEqual([]);
    expect(hits('apricot')).toEqual(['a']);
  });

  it('a map that disagrees with its index never deletes another key\'s row, and heals', () => {
    createFtsTable(db, NAME);
    indexRecord(db, NAME, 'a', 'apple');
    indexRecord(db, NAME, 'b', 'banana');
    // The index rewritten around the map: `a` moves rowid, and `b` now sits where the map says `a` is.
    const [ra, rb] = mapRows().map((row) => row.rid);
    db.exec(`DELETE FROM ${NAME}`);
    db.prepare(`INSERT INTO ${NAME} (rowid, key, blob_text) VALUES (?, 'b', 'banana'), (?, 'a', 'apple')`).run(ra, (rb ?? 0) + 10);
    indexRecord(db, NAME, 'a', 'avocado');
    expect(hits('banana')).toEqual(['b']);
    expect(hits('apple')).toEqual([]);
    expect(hits('avocado')).toEqual(['a']);
    deleteRecord(db, NAME, 'b');
    expect(hits('banana')).toEqual([]);
    expect(hits('avocado')).toEqual(['a']);
  });

  it('a prefix delete takes the key and its dotted descendants exactly: a `_` is a `_`, and case counts', () => {
    createFtsTable(db, NAME);
    for (const key of ['deal', 'deal.1', 'deal.2.x', 'dealer', 'dealer.1', 'Deal.3', 'DEAL', 'deal/1', 'a_c.1', 'axc.1']) {
      indexRecord(db, NAME, key, 'hit');
    }
    expect(deleteByPrefix(db, NAME, 'deal')).toBe(3);
    expect(deleteByPrefix(db, NAME, 'a_c')).toBe(1);
    expect(hits('hit')).toEqual(['DEAL', 'Deal.3', 'axc.1', 'deal/1', 'dealer', 'dealer.1']);
    expect(mapRows().map((row) => row.key)).toEqual(['DEAL', 'Deal.3', 'axc.1', 'deal/1', 'dealer', 'dealer.1']);
  });

  it('is dropped with its index, and a rebuild starts a fresh one', () => {
    createFtsTable(db, NAME);
    indexRecord(db, NAME, 'a', 'apple');
    dropFtsTable(db, NAME);
    expect(tableExists(MAP)).toBe(false);
    createFtsTable(db, NAME);
    indexRecord(db, NAME, 'b', 'banana');
    expect(mapRows().map((row) => row.key)).toEqual(['b']);
    rebuildIndex(db, NAME, () => indexRecord(db, NAME, 'c', 'cherry'));
    expect(mapRows().map((row) => row.key)).toEqual(['c']);
    expect(hits('banana')).toEqual([]);
    expect(hits('cherry')).toEqual(['c']);
  });

  it('survives its own making being rolled back: a dry run that writes nothing', () => {
    // Measured before this held: a dry run made the map, rolled it back, and the next real write failed
    // "no such table: work_entity_fts_keys".
    createFtsTable(db, NAME);
    const dryRun = db.transaction(() => {
      indexRecord(db, NAME, 'a', 'apple');
      throw new Error('dry run');
    });
    expect(() => dryRun()).toThrow('dry run');
    expect(tableExists(MAP)).toBe(false);
    indexRecord(db, NAME, 'b', 'banana');
    expect(mapRows().map((row) => row.key)).toEqual(['b']);
    // Gone again, under each write in turn.
    for (const write of [() => deleteRecord(db, NAME, 'b'), () => deleteByPrefix(db, NAME, 'b')]) {
      db.exec(`DROP TABLE ${MAP}`);
      write();
    }
    expect(hits('banana')).toEqual([]);
    expect(hits('apple')).toEqual([]);
  });

  it('is never made for a TEMP index; a scratch index appends instead', () => {
    db.exec(`CREATE VIRTUAL TABLE temp.scratch_fts USING fts5(key UNINDEXED, blob_text)`);
    expect(() => indexRecord(db, 'scratch_fts', 'i.0', 'apple')).toThrow(/no index 'scratch_fts' in the main schema/);
    appendRecord(db, 'scratch_fts', 'i.0', 'apple');
    appendRecord(db, 'scratch_fts', 'i.1', 'apple pie');
    expect(search(db, 'scratch_fts', { query: 'apple' }).map((row) => row.key).sort()).toEqual(['i.0', 'i.1']);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'scratch_fts%'`).all()).toEqual([]);
  });

  it('finds a key by the map\'s primary key, and a row by its rowid: no scan of the index', () => {
    createFtsTable(db, NAME);
    indexRecord(db, NAME, 'a', 'apple');
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((row) => row.detail).join(' | ');
    expect(plan(`SELECT rid FROM ${MAP} WHERE key = 'a'`)).toMatch(/SEARCH .* USING PRIMARY KEY \(key=\?\)/);
    expect(plan(`SELECT key, rid FROM ${MAP} WHERE key = 'deal' OR (key >= 'deal.' AND key < 'deal/')`)).not.toMatch(/\bSCAN\b/);
    // FTS5 names the constraints it serves after the colon: `=` a rowid lookup, nothing at all a full scan.
    expect(plan(`DELETE FROM ${NAME} WHERE rowid = 1 AND key = 'a'`)).toMatch(/VIRTUAL TABLE INDEX \d+:=$/);
    expect(plan(`DELETE FROM ${NAME} WHERE key = 'a'`)).toMatch(/VIRTUAL TABLE INDEX \d+:$/);
  });
});
