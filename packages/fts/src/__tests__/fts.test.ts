import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  createFtsTable,
  dropFtsTable,
  indexRecord,
  deleteRecord,
  deleteByPrefix,
  search,
  rebuildIndex,
} from '../index.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  createFtsTable(db, 'shared_store_fts');
});

afterEach(() => {
  db.close();
});

describe('@recued/fts', () => {
  it('indexes + searches a single record', () => {
    indexRecord(db, 'shared_store_fts', 'deal.123', 'closing acme deal stage negotiating');
    const results = search(db, 'shared_store_fts', { query: 'acme' });
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe('deal.123');
  });

  it('updates an existing record without duplicating', () => {
    indexRecord(db, 'shared_store_fts', 'deal.1', 'first value apple');
    indexRecord(db, 'shared_store_fts', 'deal.1', 'second value banana');
    const byApple = search(db, 'shared_store_fts', { query: 'apple' });
    expect(byApple).toHaveLength(0);
    const byBanana = search(db, 'shared_store_fts', { query: 'banana' });
    expect(byBanana).toHaveLength(1);
  });

  it('scope glob restricts the candidate set before FTS match', () => {
    indexRecord(db, 'shared_store_fts', 'deal.1', 'alpha');
    indexRecord(db, 'shared_store_fts', 'deal.2', 'alpha');
    indexRecord(db, 'shared_store_fts', 'contact.1', 'alpha');
    const deals = search(db, 'shared_store_fts', { scope: 'deal.*', query: 'alpha' });
    expect(deals.map((r) => r.key).sort()).toEqual(['deal.1', 'deal.2']);
  });

  it('exact-key scope resolves a single record', () => {
    indexRecord(db, 'shared_store_fts', 'deal.123', 'hello world');
    indexRecord(db, 'shared_store_fts', 'deal.456', 'hello there');
    const results = search(db, 'shared_store_fts', { scope: 'deal.123', query: 'hello' });
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe('deal.123');
  });

  it('supports standard FTS5 operators', () => {
    indexRecord(db, 'shared_store_fts', 'd.1', 'acme deal closed');
    indexRecord(db, 'shared_store_fts', 'd.2', 'acme deal open');
    const andOpen = search(db, 'shared_store_fts', { query: 'acme AND open' });
    expect(andOpen).toHaveLength(1);
    expect(andOpen[0].key).toBe('d.2');
  });

  it('deleteRecord removes a single row', () => {
    indexRecord(db, 'shared_store_fts', 'a', 'hit');
    deleteRecord(db, 'shared_store_fts', 'a');
    expect(search(db, 'shared_store_fts', { query: 'hit' })).toHaveLength(0);
  });

  it('deleteByPrefix removes the exact key + dotted children, NOT string-prefix siblings', () => {
    indexRecord(db, 'shared_store_fts', 'deal', 'hit');        // exact key
    indexRecord(db, 'shared_store_fts', 'deal.1', 'hit');      // dotted child
    indexRecord(db, 'shared_store_fts', 'deal.2', 'hit');      // dotted child
    indexRecord(db, 'shared_store_fts', 'dealer', 'hit');      // sibling — must survive
    indexRecord(db, 'shared_store_fts', 'dealer.1', 'hit');    // sibling child — must survive
    indexRecord(db, 'shared_store_fts', 'contact.1', 'hit');
    const deleted = deleteByPrefix(db, 'shared_store_fts', 'deal');
    expect(deleted).toBe(3); // deal + deal.1 + deal.2
    expect(search(db, 'shared_store_fts', { query: 'hit' }).map((r) => r.key).sort()).toEqual(
      ['contact.1', 'dealer', 'dealer.1'],
    );
  });

  it('deleteByPrefix escapes `_` so it cannot purge wildcard-sibling rows', () => {
    indexRecord(db, 'shared_store_fts', 'a_c.1', 'hit');   // target child
    indexRecord(db, 'shared_store_fts', 'axc.1', 'hit');   // `_`-as-wildcard sibling — must survive
    const deleted = deleteByPrefix(db, 'shared_store_fts', 'a_c');
    expect(deleted).toBe(1);
    expect(search(db, 'shared_store_fts', { query: 'hit' }).map((r) => r.key)).toEqual(['axc.1']);
  });

  it('scope glob escapes `_` so it cannot widen to wildcard siblings', () => {
    indexRecord(db, 'shared_store_fts', 'a_c.1', 'alpha');
    indexRecord(db, 'shared_store_fts', 'axc.1', 'alpha');
    const hits = search(db, 'shared_store_fts', { scope: 'a_c.*', query: 'alpha' });
    expect(hits.map((r) => r.key)).toEqual(['a_c.1']);
  });

  it('search tolerates punctuation queries instead of raising an FTS5 syntax error', () => {
    indexRecord(db, 'shared_store_fts', 'c.1', 'contact pat.lee@example.com owner');
    // Raw `pat.lee@example.com` is invalid FTS5 (`.`/`@`) — the hybrid falls
    // back to quoted word-tokens rather than throwing.
    const hits = search(db, 'shared_store_fts', { query: 'pat.lee@example.com' });
    expect(hits.map((r) => r.key)).toEqual(['c.1']);
    // An all-punctuation query has no word tokens → empty, never an error.
    expect(search(db, 'shared_store_fts', { query: '@#$.' })).toEqual([]);
  });

  it('rebuildIndex drops and recreates the table', () => {
    indexRecord(db, 'shared_store_fts', 'a', 'one');
    let reindexed = false;
    rebuildIndex(db, 'shared_store_fts', () => {
      indexRecord(db, 'shared_store_fts', 'a', 'two');
      reindexed = true;
    });
    expect(reindexed).toBe(true);
    expect(search(db, 'shared_store_fts', { query: 'one' })).toHaveLength(0);
    expect(search(db, 'shared_store_fts', { query: 'two' })).toHaveLength(1);
  });

  it('limit caps result count', () => {
    for (let i = 0; i < 10; i++) {
      indexRecord(db, 'shared_store_fts', `k.${i}`, 'common');
    }
    expect(search(db, 'shared_store_fts', { query: 'common', limit: 3 })).toHaveLength(3);
  });

  it('rejects bad table names (SQL-injection defense)', () => {
    expect(() => createFtsTable(db, 'bad name')).toThrow(/invalid table name/);
    expect(() => dropFtsTable(db, 'bad;drop')).toThrow(/invalid table name/);
  });
});
