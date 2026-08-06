import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  createCollectionTable,
  CollectionTableError,
  INLINE_CUTOFF_BYTES,
  MAX_LIST_LIMIT,
  type CollectionTable,
} from '../collections/table.js';
import type { CollectionRecord } from '@recued/contracts';

let db: Database.Database;
let table: CollectionTable;
let byteDeltas: number[];

const makeRecord = (overrides: Partial<CollectionRecord> = {}): CollectionRecord => {
  const record: CollectionRecord = {
    record_id: 'uid:1@INBOX',
    received_at: 1_700_000_000_000,
    modified_at: 1_700_000_000_000,
    hot_fields: { from: 'a@b.com', subject: 'hi', is_read: false },
    size_bytes: 42,
    source_id: '<msg-1@mail.example>',
    body_inline: 'Hello world',
    // D-161 P1 — collection rows are adapter-synced (always 'system');
    // the table stamps it by column default, so the round-tripped record
    // carries it. Include it in the fixture so deep-equal round-trips hold.
    origin_actor: 'system',
  };
  // Explicit `undefined` in overrides clears the field — lets callers
  // switch an inline default to a CAS-only record via `body_inline: undefined`.
  for (const [k, v] of Object.entries(overrides) as Array<[keyof CollectionRecord, unknown]>) {
    if (v === undefined) {
      delete (record as unknown as Record<string, unknown>)[k];
    } else {
      (record as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return record;
};

beforeEach(() => {
  db = new Database(':memory:');
  byteDeltas = [];
  table = createCollectionTable({
    db,
    platform: 'mail',
    slug: 'work',
    onBytesChanged: (delta) => { byteDeltas.push(delta); },
  });
});

afterEach(() => {
  db.close();
});

describe('schema + identifiers', () => {
  it('derives table names from a 10-char slug hash', () => {
    expect(table.tableName).toMatch(/^collection_mail_[a-f0-9]{10}$/);
    expect(table.ftsName).toBe(`${table.tableName}_fts`);
  });

  it('creates data + FTS5 tables', () => {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain(table.tableName);
    expect(names).toContain(table.ftsName);
  });

  it('is idempotent — re-creating the same (platform, slug) keeps data', () => {
    const rec = makeRecord();
    table.upsert(rec);
    const again = createCollectionTable({ db, platform: 'mail', slug: 'work' });
    expect(again.get(rec.record_id)).toEqual(rec);
  });

  it('distinct slugs produce distinct tables', () => {
    const t2 = createCollectionTable({ db, platform: 'mail', slug: 'personal' });
    expect(t2.tableName).not.toBe(table.tableName);
  });

  it('same slug, different platforms → different tables', () => {
    const t2 = createCollectionTable({ db, platform: 'file', slug: 'work' });
    expect(t2.tableName).not.toBe(table.tableName);
  });

  it('dropSchema removes both tables', () => {
    table.dropSchema();
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type IN ('table') AND name IN (?, ?)`,
      )
      .all(table.tableName, table.ftsName) as Array<{ name: string }>;
    expect(rows).toEqual([]);
  });
});

describe('upsert + get', () => {
  it('roundtrips an inline-body record', () => {
    const rec = makeRecord({ body_inline: 'Hello body', size_bytes: 10 });
    expect(table.upsert(rec)).toBeNull();
    expect(table.get(rec.record_id)).toEqual(rec);
  });

  it('roundtrips a CAS-only record (blob_hash, no body_inline)', () => {
    const rec = makeRecord({
      record_id: 'uid:2@INBOX',
      body_inline: undefined,
      blob_hash: 'sha256:aabbcc',
      size_bytes: 200_000,
    });
    expect(table.upsert(rec)).toBeNull();
    const got = table.get(rec.record_id)!;
    expect(got.blob_hash).toBe('sha256:aabbcc');
    expect(got.body_inline).toBeUndefined();
  });

  it('returns the prior record on update', () => {
    const first = makeRecord({ body_inline: 'v1', size_bytes: 2 });
    table.upsert(first);
    const second = makeRecord({ body_inline: 'v2', size_bytes: 2, modified_at: 1_700_000_010_000 });
    const prev = table.upsert(second);
    expect(prev?.body_inline).toBe('v1');
    expect(table.get(first.record_id)?.body_inline).toBe('v2');
  });

  it('returns null for unknown record_id', () => {
    expect(table.get('unknown')).toBeNull();
  });

  it('persists hot_fields as JSON and parses on read', () => {
    const rec = makeRecord({
      hot_fields: { labels: ['INBOX', 'IMPORTANT'], thread_id: 'T-1', is_read: false, priority: 7 },
    });
    table.upsert(rec);
    const got = table.get(rec.record_id)!;
    expect(got.hot_fields).toEqual(rec.hot_fields);
  });

  it('reports byte delta on insert + update + size change', () => {
    table.upsert(makeRecord({ record_id: 'a', size_bytes: 100 }));
    table.upsert(makeRecord({ record_id: 'a', size_bytes: 150 }));
    expect(byteDeltas).toEqual([100, 50]);
  });

  it('never reports a zero delta', () => {
    table.upsert(makeRecord({ record_id: 'a', size_bytes: 100 }));
    table.upsert(makeRecord({ record_id: 'a', size_bytes: 100 }));
    // First insert: +100. Second update (same size): 0 — skipped.
    expect(byteDeltas).toEqual([100]);
  });
});

describe('upsert validation', () => {
  it('rejects empty record_id', () => {
    expect(() => table.upsert(makeRecord({ record_id: '' }))).toThrow(
      CollectionTableError,
    );
  });

  it('rejects body_inline and blob_hash set simultaneously', () => {
    const bad = makeRecord({ body_inline: 'oops', blob_hash: 'sha256:abc' });
    expect(() => table.upsert(bad)).toThrow(/mutually exclusive/);
  });

  it('rejects body_inline larger than INLINE_CUTOFF_BYTES', () => {
    const huge = 'x'.repeat(INLINE_CUTOFF_BYTES + 1);
    const bad = makeRecord({ body_inline: huge, size_bytes: huge.length });
    expect(() => table.upsert(bad)).toThrow(/INLINE_CUTOFF_BYTES/);
  });

  it('accepts body_inline exactly at INLINE_CUTOFF_BYTES', () => {
    const atBoundary = 'x'.repeat(INLINE_CUTOFF_BYTES);
    const ok = makeRecord({ body_inline: atBoundary, size_bytes: atBoundary.length });
    expect(() => table.upsert(ok)).not.toThrow();
  });
});

describe('delete', () => {
  it('removes the row and returns the prior record', () => {
    const rec = makeRecord({ size_bytes: 30 });
    table.upsert(rec);
    const prev = table.delete(rec.record_id);
    expect(prev).toEqual(rec);
    expect(table.get(rec.record_id)).toBeNull();
  });

  it('returns null for unknown id', () => {
    expect(table.delete('unknown')).toBeNull();
  });

  it('reports a negative byte delta', () => {
    table.upsert(makeRecord({ record_id: 'a', size_bytes: 50 }));
    byteDeltas.length = 0;
    table.delete('a');
    expect(byteDeltas).toEqual([-50]);
  });

  it('removes the FTS row so search no longer finds the content', () => {
    table.upsert(makeRecord({ record_id: 'a', body_inline: 'Quarterly planning notes' }));
    expect(table.search({ platform: 'mail', slug: 'work', query: 'planning' }).length).toBe(1);
    table.delete('a');
    expect(table.search({ platform: 'mail', slug: 'work', query: 'planning' }).length).toBe(0);
  });
});

describe('list — filtering + pagination', () => {
  beforeEach(() => {
    // Seed 6 records spanning two threads over three days.
    const base = 1_700_000_000_000;
    const day = 86_400_000;
    table.upsert(makeRecord({
      record_id: 'r1', received_at: base + 0 * day,
      hot_fields: { thread_id: 'T1', is_read: true,  from: 'alice@x.com' },
      body_inline: 'first email about the q3 review',
    }));
    table.upsert(makeRecord({
      record_id: 'r2', received_at: base + 1 * day,
      hot_fields: { thread_id: 'T1', is_read: false, from: 'bob@x.com' },
      body_inline: 'reply to q3 review',
    }));
    table.upsert(makeRecord({
      record_id: 'r3', received_at: base + 1 * day,
      hot_fields: { thread_id: 'T2', is_read: false, from: 'alice@x.com' },
      body_inline: 'something about project apollo',
    }));
    table.upsert(makeRecord({
      record_id: 'r4', received_at: base + 2 * day,
      hot_fields: { thread_id: 'T1', is_read: false, from: 'alice@x.com' },
      body_inline: 'final q3 notes',
    }));
    table.upsert(makeRecord({
      record_id: 'r5', received_at: base + 2 * day,
      hot_fields: { thread_id: 'T2', is_read: true,  from: 'bob@x.com' },
      body_inline: 'apollo launch summary',
    }));
    table.upsert(makeRecord({
      record_id: 'r6', received_at: base + 3 * day,
      hot_fields: { thread_id: 'T3', is_read: false, from: 'alice@x.com' },
      body_inline: 'unrelated note',
    }));
  });

  it('orders by received_at DESC with record_id DESC as tiebreaker', () => {
    // r4/r5 share a received_at; r2/r3 share another — tiebreaker is
    // `record_id DESC` so the alphabetically-later id surfaces first
    // within each bucket. Gives a stable ordering for deterministic
    // pagination cursors.
    const rows = table.list({ platform: 'mail', slug: 'work' });
    expect(rows.map((r) => r.record_id)).toEqual(['r6', 'r5', 'r4', 'r3', 'r2', 'r1']);
  });

  it('filters by hot_fields equality (single field)', () => {
    const rows = table.list({
      platform: 'mail', slug: 'work',
      filters: { thread_id: 'T1' },
    });
    expect(rows.map((r) => r.record_id).sort()).toEqual(['r1', 'r2', 'r4']);
  });

  it('ANDs multiple hot_fields filters', () => {
    const rows = table.list({
      platform: 'mail', slug: 'work',
      filters: { thread_id: 'T1', is_read: false },
    });
    expect(rows.map((r) => r.record_id).sort()).toEqual(['r2', 'r4']);
  });

  it('applies since as inclusive lower bound on received_at', () => {
    const day = 86_400_000;
    const rows = table.list({
      platform: 'mail', slug: 'work',
      since: 1_700_000_000_000 + 2 * day,
    });
    expect(rows.map((r) => r.record_id).sort()).toEqual(['r4', 'r5', 'r6']);
  });

  it('applies until as exclusive upper bound on received_at', () => {
    const day = 86_400_000;
    const rows = table.list({
      platform: 'mail', slug: 'work',
      until: 1_700_000_000_000 + 2 * day,
    });
    expect(rows.map((r) => r.record_id).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('respects an explicit limit', () => {
    const rows = table.list({ platform: 'mail', slug: 'work', limit: 2 });
    expect(rows.map((r) => r.record_id)).toEqual(['r6', 'r5']);
  });

  it('clamps limit above MAX_LIST_LIMIT', () => {
    const rows = table.list({ platform: 'mail', slug: 'work', limit: MAX_LIST_LIMIT + 500 });
    expect(rows.length).toBeLessThanOrEqual(MAX_LIST_LIMIT);
  });

  it('rejects filter keys with SQL-unsafe chars', () => {
    expect(() => table.list({
      platform: 'mail', slug: 'work',
      filters: { "hot_fields'--": 'x' },
    })).toThrow(/invalid filter key/);
  });
});

describe('search — FTS5', () => {
  beforeEach(() => {
    table.upsert(makeRecord({ record_id: 'a', body_inline: 'The quick brown fox jumps', hot_fields: { tag: 'fox' } }));
    table.upsert(makeRecord({ record_id: 'b', body_inline: 'Lazy dogs sleep in the afternoon', hot_fields: { tag: 'dog' } }));
    table.upsert(makeRecord({ record_id: 'c', body_inline: 'Foxes and dogs share the yard', hot_fields: { tag: 'both' } }));
  });

  it('finds matching bodies with a prefix query', () => {
    // FTS5's default tokenizer is non-stemming: `fox` matches only
    // the exact token. Callers who want stemming use the prefix
    // operator (`fox*`), which the SQL snippet above permits.
    const hits = table.search({ platform: 'mail', slug: 'work', query: 'fox*' });
    const ids = hits.map((h) => h.record_id).sort();
    expect(ids).toEqual(['a', 'c']);
  });

  it('does exact-token matching by default (no stemming)', () => {
    // Record `a` contains "fox"; record `c` contains "Foxes". A bare
    // `fox` query matches only `a`.
    const hits = table.search({ platform: 'mail', slug: 'work', query: 'fox' });
    expect(hits.map((h) => h.record_id)).toEqual(['a']);
  });

  it('returns a snippet with the configured highlight markers', () => {
    const hits = table.search({ platform: 'mail', slug: 'work', query: 'brown' });
    expect(hits[0].snippet).toMatch(/<b>brown<\/b>/);
  });

  it('hydrates hot_fields alongside the match', () => {
    const hits = table.search({ platform: 'mail', slug: 'work', query: 'lazy' });
    expect(hits[0].hot_fields).toEqual({ tag: 'dog' });
  });

  it('sorts by rank (BM25: lower first)', () => {
    const hits = table.search({ platform: 'mail', slug: 'work', query: 'fox' });
    // FTS5 BM25 rank is negative; lower ranks come first.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].rank).toBeLessThanOrEqual(hits[i].rank);
    }
  });

  it('does not index CAS-only records', () => {
    table.upsert(makeRecord({
      record_id: 'd',
      body_inline: undefined,
      blob_hash: 'sha256:abcdef',
      size_bytes: 200_000,
    }));
    const hits = table.search({ platform: 'mail', slug: 'work', query: 'yard OR fox OR dog' });
    expect(hits.map((h) => h.record_id)).not.toContain('d');
  });

  it('handles a punctuated email query without an FTS5 syntax error', () => {
    table.upsert(makeRecord({
      record_id: 'e',
      body_inline: 'ping pat.lee@x.com about the renewal',
    }));
    // A raw `pat.lee@x.com` MATCH raises `fts5: syntax error near "."`; the
    // search catches it and retries with safe word-tokens, finding the row.
    const hits = table.search({
      platform: 'mail',
      slug: 'work',
      query: 'pat.lee@x.com',
    });
    expect(hits.map((h) => h.record_id)).toContain('e');
  });

  it('returns no matches for an all-punctuation query (no usable tokens)', () => {
    // Falls through to the token path, which yields no tokens → empty, no throw.
    expect(table.search({ platform: 'mail', slug: 'work', query: '@#$.' })).toEqual([]);
  });

  it('quotes reserved-word prefix stems on the fallback (no syntax error, prefix kept)', () => {
    table.upsert(makeRecord({ record_id: 'f', body_inline: 'organize the order' }));
    // `.OR*` fails as raw FTS5 (leading `.`); the fallback must emit `"OR"*`,
    // NOT a bare `OR*` — FTS5 rejects a bare reserved-word stem with a syntax
    // error. The quoted form neither throws nor loses prefix matching, so it
    // still finds "organize" / "order".
    const hits = table.search({ platform: 'mail', slug: 'work', query: '.OR*' });
    expect(hits.map((h) => h.record_id)).toContain('f');
  });

  it('indexes a composite via ftsTextFor so a hot field is searchable', () => {
    const db2 = new Database(':memory:');
    try {
      const composite = createCollectionTable({
        db: db2,
        platform: 'mail',
        slug: 'composite',
        ftsTextFor: (r) =>
          `${String((r.hot_fields as Record<string, unknown>).from ?? '')}\n${r.body_inline ?? ''}`,
      });
      composite.upsert(makeRecord({
        record_id: 'm',
        body_inline: 'plain body text',
        hot_fields: { from: 'morgan.hale@globex.test', subject: 's', is_read: false },
      }));
      // The sender lives in a hot field, off the body — the body-only default
      // index would never match it, but the composer puts it in the FTS text.
      const hits = composite.search({
        platform: 'mail',
        slug: 'composite',
        query: 'morgan.hale@globex.test',
      });
      expect(hits.map((h) => h.record_id)).toEqual(['m']);
    } finally {
      db2.close();
    }
  });
});

describe('countByAddress — D-164 P7 precise sender count', () => {
  const withFrom = (record_id: string, from: string) =>
    table.upsert(makeRecord({ record_id, hot_fields: { from, subject: 's' } }));

  it('counts rows whose field exactly equals the value (case-insensitive ASCII)', () => {
    withFrom('1', 'alice@x.com');
    withFrom('2', 'ALICE@X.COM'); // same address, different ASCII case
    withFrom('3', 'bob@x.com');
    expect(table.countByAddress('from', 'alice@x.com')).toBe(2);
    expect(table.countByAddress('from', 'ALICE@x.com')).toBe(2); // value case-folded too
    expect(table.countByAddress('from', 'bob@x.com')).toBe(1);
  });

  it('does NOT count substring near-misses (exact equality, not LIKE)', () => {
    withFrom('1', 'alice@x.com');
    withFrom('2', 'xalice@x.com'); // prefix attached
    withFrom('3', 'alice@x.com.evil'); // suffix attached
    expect(table.countByAddress('from', 'alice@x.com')).toBe(1);
  });

  it('returns 0 for a value no row carries', () => {
    withFrom('1', 'alice@x.com');
    expect(table.countByAddress('from', 'nobody@x.com')).toBe(0);
  });

  it('never counts rows missing the field (json_extract NULL)', () => {
    table.upsert(makeRecord({ record_id: '1', hot_fields: { subject: 'no from here' } }));
    expect(table.countByAddress('from', 'alice@x.com')).toBe(0);
  });

  it('returns 0 for an empty / whitespace value (nothing to match)', () => {
    withFrom('1', 'alice@x.com');
    expect(table.countByAddress('from', '')).toBe(0);
    expect(table.countByAddress('from', '   ')).toBe(0);
  });

  it('trims surrounding whitespace on the value', () => {
    withFrom('1', 'alice@x.com');
    expect(table.countByAddress('from', '  alice@x.com  ')).toBe(1);
  });

  it('compares non-ASCII letters EXACTLY but self-consistently (SQLite LOWER is ASCII-only)', () => {
    withFrom('1', 'JÖRG@x.com');
    withFrom('2', 'jörg@x.com');
    // Each value matches its OWN row regardless of the ASCII-letter case
    // (J/j folds), but the non-ASCII Ö/ö are NOT folded — so the two rows are
    // distinct. A self-consistent compare: a value finds its own row.
    expect(table.countByAddress('from', 'JÖRG@x.com')).toBe(1);
    expect(table.countByAddress('from', 'jörg@x.com')).toBe(1);
    expect(table.countByAddress('from', 'jÖRG@x.com')).toBe(1); // ASCII case folds, Ö stays
  });

  it('honors the field arg — generic over any SCALAR hot field, not hardcoded to "from"', () => {
    table.upsert(makeRecord({ record_id: '1', hot_fields: { from: 'a@x.com', subject: 'Renewal' } }));
    table.upsert(makeRecord({ record_id: '2', hot_fields: { from: 'b@x.com', subject: 'renewal' } }));
    expect(table.countByAddress('subject', 'renewal')).toBe(2); // ASCII case-folded
    expect(table.countByAddress('from', 'a@x.com')).toBe(1);
  });

  it('throws on an invalid field identifier (matches list-filter key validation)', () => {
    expect(() => table.countByAddress('from; DROP', 'x')).toThrow(CollectionTableError);
    expect(() => table.countByAddress('$.from', 'x')).toThrow(CollectionTableError);
  });
});

describe('totalBytes + referencedBlobHashes', () => {
  it('sums size_bytes across rows', () => {
    table.upsert(makeRecord({ record_id: 'a', size_bytes: 100 }));
    table.upsert(makeRecord({ record_id: 'b', size_bytes: 250 }));
    expect(table.totalBytes()).toBe(350);
  });

  it('lists only blob_hashes actually referenced, deduped', () => {
    table.upsert(makeRecord({ record_id: 'a', body_inline: undefined, blob_hash: 'h1', size_bytes: 100 }));
    table.upsert(makeRecord({ record_id: 'b', body_inline: undefined, blob_hash: 'h2', size_bytes: 100 }));
    table.upsert(makeRecord({ record_id: 'c', body_inline: undefined, blob_hash: 'h1', size_bytes: 100 }));
    table.upsert(makeRecord({ record_id: 'd', body_inline: 'no-blob', size_bytes: 8 }));
    const hashes = table.referencedBlobHashes();
    expect(hashes).toEqual(new Set(['h1', 'h2']));
  });
});

describe('pruneOlderThan', () => {
  beforeEach(() => {
    const day = 86_400_000;
    const base = 1_700_000_000_000;
    table.upsert(makeRecord({ record_id: 'old1', received_at: base + 0 * day, size_bytes: 50, body_inline: undefined, blob_hash: 'h-old-1' }));
    table.upsert(makeRecord({ record_id: 'old2', received_at: base + 1 * day, size_bytes: 25, body_inline: 'text' }));
    table.upsert(makeRecord({ record_id: 'keep1', received_at: base + 5 * day, size_bytes: 10, body_inline: 'recent' }));
  });

  it('deletes rows with received_at < cutoff', () => {
    const day = 86_400_000;
    const cutoff = 1_700_000_000_000 + 2 * day;
    const result = table.pruneOlderThan(cutoff);
    expect(result.pruned_count).toBe(2);
    expect(result.bytes_freed).toBe(75);
    expect(result.blob_hashes_freed).toEqual(['h-old-1']);
    expect(table.get('old1')).toBeNull();
    expect(table.get('old2')).toBeNull();
    expect(table.get('keep1')).not.toBeNull();
  });

  it('returns a zero summary when nothing matches', () => {
    const result = table.pruneOlderThan(0);
    expect(result).toEqual({ pruned_count: 0, bytes_freed: 0, blob_hashes_freed: [] });
  });

  it('drops FTS rows for the pruned records', () => {
    const day = 86_400_000;
    table.pruneOlderThan(1_700_000_000_000 + 2 * day);
    const hits = table.search({ platform: 'mail', slug: 'work', query: 'text' });
    expect(hits.length).toBe(0);
  });

  it('reports the negative byte delta to the gate hook', () => {
    byteDeltas.length = 0;
    const day = 86_400_000;
    table.pruneOlderThan(1_700_000_000_000 + 2 * day);
    expect(byteDeltas).toEqual([-75]);
  });
});

describe('thread-id lookup index (D-123 producer hot path)', () => {
  /** ⛔ WHY THE PLAN AND NOT THE RESULT. The D-123 producers look records up by
   *  thread ONCE PER RECORD, so a full scan there makes a producer pass
   *  quadratic in the mail corpus — measured at 100k mails, 21.8ms per lookup,
   *  ~36 minutes of pure scanning for one pass. The answers were always
   *  correct; only the plan was wrong, so only the plan can catch a
   *  regression. */
  const mkDb = (): Database.Database => {
    const db = new Database(':memory:');
    createCollectionTable({ db, platform: 'mail', slug: 'probe' });
    return db;
  };
  const tableFor = (db: Database.Database): string =>
    (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
        AND name LIKE 'collection_mail_%' AND name NOT LIKE '%_fts%'`,
    ).get() as { name: string }).name;

  it('SEARCHes by thread_id instead of scanning', () => {
    const db = mkDb();
    const t = tableFor(db);
    const plan = (db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT received_at, hot_fields FROM "${t}"
          WHERE json_extract(hot_fields, '$.thread_id') = ?`,
      )
      .all('x') as Array<{ detail: string }>).map((r) => r.detail).join(' ; ');
    expect(plan).toMatch(/SEARCH/);
    expect(plan).not.toMatch(/^SCAN/);
    db.close();
  });

  it('the index is PARTIAL, so rows without a thread_id are not indexed', () => {
    // Calendar and file collections share this DDL and carry no thread_id.
    // A full index would make every one of their rows pay for a column they
    // do not have.
    const db = mkDb();
    const t = tableFor(db);
    const ddl = (db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name = ?`)
      .get(`idx_${t}_thread_id`) as { sql: string } | undefined)?.sql ?? '';
    expect(ddl).toMatch(/WHERE json_extract\(hot_fields, '\$\.thread_id'\) IS NOT NULL/);
    db.close();
  });

  it('an EXISTING collection picks the index up without a migration', () => {
    // `CREATE TABLE IF NOT EXISTS` skips a table that already exists, so a new
    // index declared alongside it only reaches existing installs because the
    // whole `db.exec` block re-runs on every `createCollectionTable` call.
    // That is load-bearing and easy to break by moving the index into the
    // create-only path.
    const db = mkDb();
    const t = tableFor(db);
    // Second call against the now-existing table must still ensure the index.
    db.exec(`DROP INDEX IF EXISTS idx_${t}_thread_id`);
    createCollectionTable({ db, platform: 'mail', slug: 'probe' });
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name = ?`)
      .get(`idx_${t}_thread_id`);
    expect(idx).toBeDefined();
    db.close();
  });

  it('still returns exactly the rows of the requested thread', () => {
    const db = mkDb();
    const t = tableFor(db);
    const ins = db.prepare(
      `INSERT INTO "${t}" (record_id, received_at, modified_at, hot_fields, size_bytes, source_id)
       VALUES (?, ?, ?, ?, 1, 's')`,
    );
    ins.run('a', 1, 1, JSON.stringify({ thread_id: 't1' }));
    ins.run('b', 2, 2, JSON.stringify({ thread_id: 't2' }));
    ins.run('c', 3, 3, JSON.stringify({ thread_id: 't1' }));
    ins.run('d', 4, 4, JSON.stringify({ subject: 'no thread' }));
    const rows = (db
      .prepare(`SELECT record_id FROM "${t}" WHERE json_extract(hot_fields, '$.thread_id') = ? ORDER BY record_id`)
      .all('t1') as Array<{ record_id: string }>).map((r) => r.record_id);
    expect(rows).toEqual(['a', 'c']);
    db.close();
  });
});
