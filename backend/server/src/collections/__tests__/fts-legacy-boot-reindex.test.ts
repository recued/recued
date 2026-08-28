import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { FTS_CONTENT_FORMAT, FTS_REINDEX_PAGE } from '@recued/fts';

import { createCollectionTable } from '../table.js';
import { mailFtsText } from '../mail/mail-collection.js';

/** ⛔⛔ THIS EXISTS BECAUSE THE PACKAGE-LEVEL MIGRATION TEST PASSED WHILE THIS
 *  PATH WAS BROKEN. That test supplied its OWN `reindex` callback — a two-line
 *  closure — and so proved the migration CALLS BACK, never that the REAL
 *  callback works. The real one reads rows and writes the FTS table per row,
 *  and better-sqlite3 refuses a write while a read statement is iterating.
 *
 *  Measured before the fix: the rebuild threw, and (with the drop that used to
 *  precede it) left the index EMPTY — a Latin `search(sandhurst)` went from 3
 *  matches to 0 with nothing red in the suite. A live bench task that had
 *  scored 8/8 is what surfaced it.
 *
 *  ⇒ drive the callback the composition root actually supplies. */
const build = (db: Database.Database) =>
  createCollectionTable({ db, platform: 'mail', slug: 'inbox', ftsTextFor: mailFtsText });

/** ⚠ `n` is asserted, because the first cut of this file imported
 *  `FTS_REINDEX_PAGE` from `../table.js` — where it is IMPORTED, not exported —
 *  so it was `undefined`, `n` was `NaN`, the loop ran zero times and the test
 *  failed on an empty index rather than on the thing it was written to catch. */
const seed = (t: ReturnType<typeof build>, n: number): void => {
  expect(Number.isFinite(n) && n > 0, 'the row count must be a real number').toBe(true);
  for (let i = 0; i < n; i += 1) {
    t.upsert({
      record_id: `mail:r${String(i).padStart(6, '0')}`,
      hot_fields: {
        subject: `Sandhurst renewal ${i}`, from: 'a@e.com', to: ['b@e.com'],
        cc: [], thread_id: 'T',
      },
      received_at: i, modified_at: i,
      body_inline: '商定为 83 天通知期',
      size_bytes: 20, source_id: 'inbox',
    } as never);
  }
};

describe('a legacy-format index rebuilds itself at boot', () => {
  it('survives a rebuild LARGER THAN ONE PAGE without throwing or emptying', () => {
    // Deliberately > FTS_REINDEX_PAGE so the paging loop runs more than once —
    // a single-page rebuild would pass even against the `.iterate()` version on
    // some drivers, which is the kind of green that started this.
    const db = new Database(':memory:');
    try {
      let table = build(db);
      seed(table, FTS_REINDEX_PAGE * 2 + 40);
      expect(table.search({ query: 'sandhurst', limit: 5 } as never).length).toBe(5);

      // Force the pre-fix state: an index with no recorded content format.
      db.prepare('DELETE FROM fts_content_format').run();

      expect(() => { table = build(db); }, 'the rebuild must not throw').not.toThrow();

      expect(
        table.search({ query: 'sandhurst', limit: 5 } as never).length,
        'the LATIN index must survive a rebuild it did not need',
      ).toBe(5);
      expect(
        table.search({ query: '通知', limit: 5 } as never).length,
        'and the mid-run CJK term must now be reachable',
      ).toBe(5);
    } finally { db.close(); }
  });

  it('records the format so the next boot is free', () => {
    const db = new Database(':memory:');
    try {
      let table = build(db);
      seed(table, 3);
      db.prepare('DELETE FROM fts_content_format').run();
      table = build(db);
      const row = db.prepare('SELECT format FROM fts_content_format WHERE name = ?')
        .get('collection_mail_caadbcffec_fts') as { format: number } | undefined;
      // ⚠ Against the CONSTANT, not a literal — a format bump is a normal event
      // (it is how a stored-text change reaches existing servers) and should not
      // require editing a test that is about the RECORDING, not the number.
      expect(row?.format, 'the rebuild must record what it wrote').toBe(FTS_CONTENT_FORMAT);
      // A second construction must find nothing stale and leave the rows alone.
      table = build(db);
      expect(table.search({ query: 'sandhurst', limit: 5 } as never).length).toBe(3);
    } finally { db.close(); }
  });
});

/** ⛔ THESE TESTS OUTLIVED THE MECHANISM THEY WERE WRITTEN AGAINST. They were
 *  built when search returned an FTS5 `snippet()` and the fix was to WIDEN the
 *  window for unspaced scripts. The window is gone (2026-08-28): search now
 *  hydrates the record's own `body` from the base table. The PROPERTY they
 *  guard is unchanged and is the whole point — a search result must carry the
 *  answer, not a fragment that stops short of it — so they assert it of `body`. */
describe('search results carry the answer under per-grapheme tokenisation', () => {
  it('a CJK query reaches text a 15-TOKEN window would have cut off', () => {
    // ⛔⛔ FOUND BY A LIVE MODEL, NOT BY THE SUBSTRATE. `snippet()` counts
    // TOKENS, and format 2 made a CJK token ONE CHARACTER — so the fixed count
    // silently became a fixed CHARACTER window, about a seventh of what a Latin
    // row gets. Retrieval was correct throughout; what broke was how much
    // CONTEXT reached the model.
    //
    // Measured on the CJK inverted-spread task: the index worked (mail reached
    // 6/7 vs 0/7) and the model still answered "I found the email but cannot see
    // the details" in four of those, because the snippet stopped before the
    // figure. No assertion of the form "did the row match" can see that.
    const db = new Database(':memory:');
    try {
      const table = build(db);
      table.upsert({
        record_id: 'mail:cjk0',
        hot_fields: {
          subject: '桑德赫斯特续约条款', from: 'ops@sandhurst-bench.test',
          to: ['me@recued-bench.test'], cc: [], thread_id: 'T',
        },
        received_at: 1, modified_at: 1,
        body_inline: '桑德赫斯特的续约已商定为 83 天通知期。',
        size_bytes: 40, source_id: 'inbox',
      } as never);
      for (const q of ['续约', '通知', '商定', '桑德赫斯特 续约 通知期']) {
        const r = table.search({ query: q, limit: 3 } as never) as Array<{ body?: string }>;
        expect(r.length, `${q} must match`).toBeGreaterThan(0);
        expect(
          r[0]?.body ?? '',
          `the result for ${q} must carry the answer, not stop short of it`,
        ).toContain('83');
      }
    } finally { db.close(); }
  });

  // ⛔⛔ THIS TEST USED TO PIN THE DEFECT. It asserted a Latin query "must keep
  // the narrow window it always had" — the CJK fix widened one script and this
  // guarded the decision not to widen the other. The reasoning was that the
  // measured failure was CJK-only. It was not: bench 276 reached the right mail
  // 11/11 and answered 0/11 on Latin rows, because the same window cut the same
  // way. A test can hold a defect in place by asserting the half-fix, and this
  // is what that looks like — so it now asserts the property, not the tuning.
  it('and a LATIN query gets the record too — the fix is not script-specific', () => {
    const db = new Database(':memory:');
    try {
      const table = build(db);
      seed(table, 2);
      const r = table.search({ query: 'sandhurst', limit: 2 } as never) as
        Array<{ body?: string }>;
      expect(r.length).toBeGreaterThan(0);
      expect(r[0]?.body, 'a Latin match must carry its record body').toBeTruthy();
    } finally { db.close(); }
  });
});

describe('the mail result shows the ANSWER, not the address headers', () => {
  it('surfaces body text a leading from/to line used to push out of the window', () => {
    // ⛔⛔ FOUND BY A LIVE MODEL, AND IT REPORTED THE SYMPTOM ACCURATELY.
    // `snippet()` returns a TOKEN window centred on the match. The mail blob
    // used to open with from/to/cc, and `ops@sandhurst-bench.test` alone
    // tokenises to FOUR terms — so the address lines ate 8 of 15 and the window
    // closed four tokens short of the sentence that answered the question:
    //
    //   ops@…\nme@…\nRenewal notice period\nWe agreed the renewal…
    //
    // The model said "the full message content isn't visible in the search
    // results", which was true of what it had been handed. Nothing was wrong
    // with retrieval — the row matched — so no assertion about matching could
    // have caught it.
    const db = new Database(':memory:');
    try {
      const table = build(db);
      table.upsert({
        record_id: 'mail:snip',
        hot_fields: {
          subject: 'Renewal notice period', from: 'ops@sandhurst-bench.test',
          to: ['me@recued-bench.test'], cc: [], thread_id: 'T',
        },
        received_at: 1, modified_at: 1,
        body_inline: 'We agreed the renewal notice period is 83 days.',
        size_bytes: 46, source_id: 'inbox',
      } as never);
      for (const q of ['Sandhurst renewal notice period', 'renewal notice period', 'notice period']) {
        const r = table.search({ query: q, limit: 3 } as never) as Array<{ body?: string }>;
        expect(r.length, `${q} must match`).toBeGreaterThan(0);
        expect(
          r[0]?.body ?? '',
          `the result for "${q}" must carry the figure, not stop short of it`,
        ).toContain('83');
      }
      // ⚠ And the addresses are still INDEXED. Reordering the blob changed what
      // a window centred on the match happened to show; it never changed what
      // the index holds, and the body hydration does not change it either.
      expect(
        (table.search({ query: 'sandhurst-bench.test', limit: 3 } as never) as unknown[]).length,
        'an address must remain searchable',
      ).toBeGreaterThan(0);
    } finally { db.close(); }
  });
});
