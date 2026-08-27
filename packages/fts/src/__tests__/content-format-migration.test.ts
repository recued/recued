import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  createFtsTable,
  indexRecord,
  search,
  toFtsMatch,
  markFtsContentFormat,
  FTS_CONTENT_FORMAT,
} from '../index.js';

const NAME = 't_fts';
const DOC = '关于桑德赫斯特的续约，我们商定的通知期是九十天。';

/** Build an index in the PRE-fix shape: table present, text stored verbatim, no
 *  recorded format — exactly what an existing server carries. */
const legacyIndex = (db: Database.Database): void => {
  createFtsTable(db, NAME);
  db.prepare(`DELETE FROM ${NAME} WHERE key = ?`).run('r1');
  db.prepare(`INSERT INTO ${NAME} (key, blob_text) VALUES (?, ?)`).run('r1', DOC);
  db.prepare('DELETE FROM fts_content_format WHERE name = ?').run(NAME);
};

const hits = (db: Database.Database, q: string): number => {
  const m = toFtsMatch(q);
  return m === null ? 0 : search(db, NAME, { query: m, limit: 5 }).length;
};

describe('FTS content-format migration', () => {
  it('rebuilds a legacy index once, and the rebuild is what makes CJK reachable', () => {
    const db = new Database(':memory:');
    try {
      legacyIndex(db);
      expect(hits(db, '通知'), 'mid-run CJK is unreachable before').toBe(0);

      let ran = 0;
      const res = createFtsTable(db, NAME, {
        reindex: () => { ran += 1; indexRecord(db, NAME, 'r1', DOC); },
      });

      expect(res.migrated, 'a stale format must report as migrated').toBe(true);
      expect(ran, 'and must actually call the caller back').toBe(1);
      expect(hits(db, '通知'), 'mid-run CJK reachable after').toBe(1);
    } finally { db.close(); }
  });

  it('is IDEMPOTENT — a second boot must not rebuild', () => {
    // ⛔ Without the recorded format this walks every row on EVERY boot, which
    // on a large mailbox is worse than the problem being fixed.
    const db = new Database(':memory:');
    try {
      legacyIndex(db);
      createFtsTable(db, NAME, { reindex: () => indexRecord(db, NAME, 'r1', DOC) });
      let again = 0;
      const res = createFtsTable(db, NAME, { reindex: () => { again += 1; } });
      expect(res.migrated).toBe(false);
      expect(again, 'the second boot must be free').toBe(0);
    } finally { db.close(); }
  });

  it('⛔ NEVER EMPTIES A STALE INDEX WHOSE CALLER SUPPLIES NO REINDEX', () => {
    // The fail-safe that made this design admissible at all. Four of the five
    // call sites in the wider codebase ignored the pre-existing `migrated` flag
    // (harmlessly — none passed a tokenizer), so a design where forgetting the
    // callback empties a live index would have turned that habit into data loss.
    // Forgetting it costs the improvement on old rows, never the rows.
    const db = new Database(':memory:');
    try {
      legacyIndex(db);
      createFtsTable(db, NAME);
      const rows = (db.prepare(`SELECT count(*) c FROM ${NAME}`).get() as { c: number }).c;
      expect(rows, 'the legacy row must survive an un-migratable boot').toBe(1);
    } finally { db.close(); }
  });

  it('marks the format only AFTER an async rebuild completes', () => {
    // `markFtsContentFormat` is the escape hatch for stores whose rebuild must
    // await (resolving CAS bodies). Marking early would record a format the
    // index does not hold, and the flag is the only thing that would ever have
    // corrected it.
    const db = new Database(':memory:');
    try {
      legacyIndex(db);
      createFtsTable(db, NAME);
      expect(
        db.prepare('SELECT format FROM fts_content_format WHERE name = ?').get(NAME),
      ).toBeUndefined();
      indexRecord(db, NAME, 'r1', DOC);
      markFtsContentFormat(db, NAME);
      expect(
        (db.prepare('SELECT format FROM fts_content_format WHERE name = ?')
          .get(NAME) as { format: number }).format,
      ).toBe(FTS_CONTENT_FORMAT);
      expect(createFtsTable(db, NAME, { reindex: () => {} }).migrated).toBe(false);
    } finally { db.close(); }
  });

  it('a FRESH index is born current — no rebuild on first ever boot', () => {
    const db = new Database(':memory:');
    try {
      let ran = 0;
      const res = createFtsTable(db, NAME, { reindex: () => { ran += 1; } });
      expect(res.migrated).toBe(false);
      expect(ran).toBe(0);
      indexRecord(db, NAME, 'r1', DOC);
      expect(hits(db, '通知'), 'and it writes format-2 text').toBe(1);
    } finally { db.close(); }
  });
});
