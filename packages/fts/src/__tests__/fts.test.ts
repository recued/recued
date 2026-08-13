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
  toFtsMatch,
  toFtsMatchLadder,
  tokenizeFtsQuery,
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

describe('createFtsTable — tokenizer declaration + migration', () => {
  const declaredSql = (name: string): string =>
    (db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(name) as { sql: string }).sql;

  it('omitting the tokenizer leaves today`s declaration untouched (no consumer moves)', () => {
    // Every other index in the codebase calls it this way; the porter work must
    // not reach them.
    expect(declaredSql('shared_store_fts')).not.toMatch(/tokenize/i);
    expect(createFtsTable(db, 'shared_store_fts')).toEqual({ migrated: false });
    expect(declaredSql('shared_store_fts')).not.toMatch(/tokenize/i);
  });

  it('a declared tokenizer reaches the DDL and actually stems', () => {
    createFtsTable(db, 'stemmed', { tokenizer: 'porter unicode61 remove_diacritics 2' });
    expect(declaredSql('stemmed')).toContain("tokenize='porter unicode61 remove_diacritics 2'");
    indexRecord(db, 'stemmed', 'k1', 'The Pro plan can be cancelled at any time.');
    // The whole point: a query word the document never literally contains.
    expect(search(db, 'stemmed', { query: '"cancel"' }).map((r) => r.key)).toEqual(['k1']);
    expect(search(db, 'stemmed', { query: '"cancellation"' }).map((r) => r.key)).toEqual(['k1']);
  });

  it('⛔ MIGRATES an index declared with a DIFFERENT tokenizer — `IF NOT EXISTS` alone is INERT', () => {
    // The premise, pinned: re-running the CREATE cannot change a tokenizer.
    // Without the drop, porter would reach fresh installs only.
    createFtsTable(db, 'mig');
    indexRecord(db, 'mig', 'k1', 'cancelled');
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS mig USING fts5(key UNINDEXED, blob_text, tokenize='porter')`);
    expect(declaredSql('mig')).not.toMatch(/porter/);

    const result = createFtsTable(db, 'mig', { tokenizer: 'porter unicode61' });
    expect(result).toEqual({ migrated: true });
    expect(declaredSql('mig')).toContain("tokenize='porter unicode61'");
    // Dropped means EMPTY — the caller owes the reindex `migrated` announces.
    expect(search(db, 'mig', { query: '"cancelled"' })).toEqual([]);
  });

  it('is IDEMPOTENT on a matching declaration — no rebuild-on-every-boot loop', () => {
    // If the emitted clause and the recorded one ever disagreed, every store
    // construction would drop a live index and force a full reindex.
    createFtsTable(db, 'stable', { tokenizer: 'porter unicode61 remove_diacritics 2' });
    indexRecord(db, 'stable', 'k1', 'cancelled');
    for (let i = 0; i < 3; i++) {
      expect(
        createFtsTable(db, 'stable', { tokenizer: 'porter unicode61 remove_diacritics 2' }),
      ).toEqual({ migrated: false });
    }
    expect(search(db, 'stable', { query: '"cancel"' })).toHaveLength(1); // rows survived
  });

  it('migrates in BOTH directions — dropping a tokenizer is a change too', () => {
    createFtsTable(db, 'down', { tokenizer: 'porter' });
    expect(createFtsTable(db, 'down')).toEqual({ migrated: true });
    expect(declaredSql('down')).not.toMatch(/tokenize/i);
  });

  it('rejects an injection-shaped tokenizer BEFORE touching the index', () => {
    createFtsTable(db, 'guarded', { tokenizer: 'porter' });
    indexRecord(db, 'guarded', 'k1', 'cancelled');
    expect(() => createFtsTable(db, 'guarded', { tokenizer: "ascii'); DROP TABLE guarded; --" }))
      .toThrow(/invalid tokenizer/);
    // The live index survived the rejection — validation precedes the drop.
    expect(search(db, 'guarded', { query: '"cancel"' })).toHaveLength(1);
  });

  it('rebuildIndex keeps the tokenizer it is given (and downgrades without it)', () => {
    createFtsTable(db, 'rb', { tokenizer: 'porter unicode61' });
    rebuildIndex(db, 'rb', () => indexRecord(db, 'rb', 'k1', 'cancelled'), {
      tokenizer: 'porter unicode61',
    });
    expect(search(db, 'rb', { query: '"cancel"' })).toHaveLength(1);
    // ⚠ The documented footgun, pinned so it stays a known one.
    rebuildIndex(db, 'rb', () => indexRecord(db, 'rb', 'k1', 'cancelled'));
    expect(search(db, 'rb', { query: '"cancel"' })).toHaveLength(0);
  });
});

describe('tokenizeFtsQuery', () => {
  it('splits into all tokens and content tokens, lowercased with `*` stripped', () => {
    expect(tokenizeFtsQuery('What is your Refund Policy?')).toEqual({
      all: ['what', 'is', 'your', 'refund', 'policy'],
      content: ['refund', 'policy'],
    });
    expect(tokenizeFtsQuery('refund*').all).toEqual(['refund']);
  });

  it('a query of nothing but stopwords has NO content tokens', () => {
    expect(tokenizeFtsQuery('what is it').content).toEqual([]);
  });

  it('no word tokens at all', () => {
    expect(tokenizeFtsQuery('@#$.')).toEqual({ all: [], content: [] });
  });
});

describe('toFtsMatchLadder', () => {
  it('rung 1 is byte-identical to toFtsMatch — a query that matched today is untouched', () => {
    for (const q of ['refund', 'refund policy', 'What is your refund policy?', 'pat.lee@x.com']) {
      expect(toFtsMatchLadder(q)[0]!.match).toBe(toFtsMatch(q));
      expect(toFtsMatchLadder(q)[0]!.kind).toBe('exact');
    }
  });

  it('adds a content-only AND rung when the query carries function words', () => {
    expect(toFtsMatchLadder('What is your refund policy?')).toEqual([
      { kind: 'exact', match: '"What" "is" "your" "refund" "policy"' },
      { kind: 'relaxed', match: '"refund" "policy"' },
      { kind: 'loose', match: '"refund" OR "policy"' },
    ]);
  });

  it('⛔ each rung NAMES its kind — the index does not determine it', () => {
    // The two conditional rungs are INDEPENDENT, so index 1 is `loose` on one
    // of these and `relaxed` on the other. Inferring from position reports the
    // opposite of the truth half the time.
    expect(toFtsMatchLadder('refund policy')[1]!.kind).toBe('loose');
    expect(toFtsMatchLadder('what is the refund')[1]!.kind).toBe('relaxed');
  });

  it('skips the content rung when there are no function words to drop', () => {
    // Nothing to relax on rung 2 — it would be a byte-identical re-run of rung 1.
    expect(toFtsMatchLadder('refund policy')).toEqual([
      { kind: 'exact', match: '"refund" "policy"' },
      { kind: 'loose', match: '"refund" OR "policy"' },
    ]);
  });

  it('a single content word gets no OR rung (it would duplicate the AND rung)', () => {
    expect(toFtsMatchLadder('what is the refund')).toEqual([
      { kind: 'exact', match: '"what" "is" "the" "refund"' },
      { kind: 'relaxed', match: '"refund"' },
    ]);
  });

  it('⛔ a query of nothing but stopwords gets rung 1 ALONE — never an OR over function words', () => {
    // OR-ing "what"/"is"/"it" would match most of the corpus. Returning nothing
    // is the better answer for a query that carries no retrieval signal.
    expect(toFtsMatchLadder('what is it')).toEqual([
      { kind: 'exact', match: '"what" "is" "it"' },
    ]);
  });

  it('⛔ NEGATIONS are not stopwords — relaxing them would invert the query', () => {
    // "not" survives into every rung: dropping it turns the question into its
    // own opposite, which no amount of extra recall makes acceptable.
    for (const rung of toFtsMatchLadder('how to not delete a record')) {
      expect(rung.match).toContain('"not"');
    }
    expect(toFtsMatchLadder('how to not delete a record')[1]!.match).toBe(
      '"not" "delete" "record"',
    );
  });

  it('preserves the `*` prefix operator on every rung', () => {
    expect(toFtsMatchLadder('what is a refund*')).toEqual([
      { kind: 'exact', match: '"what" "is" "a" "refund"*' },
      { kind: 'relaxed', match: '"refund"*' },
    ]);
  });

  it('no word tokens → no rungs (the caller yields no matches)', () => {
    expect(toFtsMatchLadder('@#$.')).toEqual([]);
  });

  it('THE POINT — a whole natural-language question finds the entry the AND rung missed', () => {
    indexRecord(db, 'shared_store_fts', 'qa1',
      'Refund policy\nCustomers may request a refund within 30 days of purchase.');
    indexRecord(db, 'shared_store_fts', 'qa2',
      'Pro plan billing\nThe Pro plan bills monthly and can be cancelled at any time.');

    const walk = (q: string): string[] => {
      for (const rung of toFtsMatchLadder(q)) {
        const hits = search(db, 'shared_store_fts', { query: rung.match });
        if (hits.length > 0) return hits.map((h) => h.key);
      }
      return [];
    };

    // The exact rung alone returns NOTHING for this question — the regression
    // this ladder exists to fix. Pinned so the premise can't quietly stop being true.
    expect(search(db, 'shared_store_fts', {
      query: toFtsMatch('What is your refund policy?')!,
    })).toEqual([]);
    expect(walk('What is your refund policy?')).toEqual(['qa1']);

    // An exact match is NOT diluted: rung 1 answers and the looser rungs never run.
    expect(walk('refund policy')).toEqual(['qa1']);

    // Terms spanning two entries fall through to the OR rung and return both.
    expect(walk('refund policy and billing').sort()).toEqual(['qa1', 'qa2']);
  });
});
