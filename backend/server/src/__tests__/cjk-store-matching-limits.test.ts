import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

/** ⛔⛔ WHY THIS TEST USES A REAL SQLITE AND NOT THE INDEX'S FAKE PROBE.
 *
 *  `index-cooccurrence.test.ts` models each store with a double that splits on
 *  `/\W+/`. `\W` is `[^A-Za-z0-9_]`, so every CJK character is a SEPARATOR
 *  there and a Han document tokenises to nothing — the double cannot represent
 *  the question this file asks. Testing CJK reach through it would certify the
 *  double's ASCII assumptions, not the stores.
 *
 *  What is pinned here is the SUBSTRATE fact the pre-seed index's CJK support
 *  rests on (D-251): a segmented CJK term reaches the substring-matched stores
 *  fully and the FTS-matched ones only at the start of a run. */
describe('CJK reach differs by store MECHANISM, not by store', () => {
  const DOC = '续约的通知期我们商定了多久';

  it('JS substring — how recall and file match — reaches ANY position', () => {
    // `recall.search` matches with `normalized.includes(term)`
    // (chat-recall-search.ts) and `file.search` filters filenames the same way
    // (chat-tool-handlers.ts). Neither needs a tokenizer, so neither needs
    // segmentation on the STORED side.
    for (const term of ['续约', '通知', '商定', '多久']) {
      expect(DOC.includes(term), `substring must reach ${term} mid-run`).toBe(true);
    }
  });

  it('SQL LIKE — how contact matches — also reaches any position', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE c(name TEXT)');
      db.prepare('INSERT INTO c VALUES(?)').run('张伟明 续约负责人');
      for (const term of ['续约', '伟明', '负责人']) {
        const n = db.prepare('SELECT count(*) c FROM c WHERE name LIKE ?')
          .get(`%${term}%`) as { c: number };
        expect(n.c, `LIKE must reach ${term}`).toBe(1);
      }
    } finally { db.close(); }
  });

  it('FTS5 unicode61 — how mail, calendar and memory match — reaches only a run START', () => {
    // ⚠ THIS IS THE LIMIT, ASSERTED RATHER THAN DESCRIBED. `unicode61` does not
    // segment CJK, so the whole unspaced run is ONE token: a prefix query
    // matches, an interior term does not.
    const db = new Database(':memory:');
    try {
      db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='unicode61')");
      db.prepare('INSERT INTO t VALUES(?)').run(DOC);
      const hits = (q: string) =>
        (db.prepare('SELECT count(*) c FROM t WHERE t MATCH ?').get(q) as { c: number }).c;
      expect(hits('"续约"*'), 'a term at the START of the run matches').toBe(1);
      expect(hits('"通知期"*'), 'a term INSIDE the run does not').toBe(0);
    } finally { db.close(); }
  });

  it('⛔ TRIGRAM IS NOT THE FIX — it has a THREE-CHARACTER FLOOR', () => {
    // The textbook answer for CJK in SQLite, and it misses precisely the words
    // a Chinese corpus is made of: two characters is the most common word
    // length (续约 renewal, 通知 notice, 合同 contract, 付款 payment). Anyone
    // reaching for `trigram` to "fix CJK search" should fail here first.
    const db = new Database(':memory:');
    try {
      db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')");
      db.prepare('INSERT INTO t VALUES(?)').run(DOC);
      const hits = (q: string) =>
        (db.prepare('SELECT count(*) c FROM t WHERE t MATCH ?').get(`"${q}"`) as { c: number }).c;
      expect(hits('通知期'), '3 characters works').toBe(1);
      expect(hits('续约'), '2 characters does NOT — the floor').toBe(0);
      expect(hits('通知'), '2 characters does NOT — the floor').toBe(0);
    } finally { db.close(); }
  });

  it('the WORKING fts fix is per-character tokenisation, and Latin survives it', () => {
    // Space-separating Han at FTS-write time makes each character a token, so a
    // 2-character word matches as an ADJACENT PHRASE. Recorded as the migration
    // D-251 deliberately did not bundle — it rewrites shipped derived rows.
    const sep = (t: string) =>
      t.replace(/(\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana})/gu, '$1 ');
    const db = new Database(':memory:');
    try {
      db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='unicode61')");
      db.prepare('INSERT INTO t VALUES(?)').run(sep(DOC));
      db.prepare('INSERT INTO t VALUES(?)').run(sep('Sandhurst renewal notice'));
      const phrase = (q: string) =>
        (db.prepare('SELECT count(*) c FROM t WHERE t MATCH ?')
          .get(`"${[...q].join(' ')}"`) as { c: number }).c;
      for (const q of ['续约', '通知', '通知期', '多久']) {
        expect(phrase(q), `${q} must match as an adjacent phrase`).toBe(1);
      }
      const latin = (db.prepare("SELECT count(*) c FROM t WHERE t MATCH 'sandhurst'")
        .get() as { c: number }).c;
      expect(latin, 'Latin in the same blob must be unaffected').toBe(1);
    } finally { db.close(); }
  });
});
