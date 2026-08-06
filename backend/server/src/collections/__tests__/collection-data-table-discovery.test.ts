/** Regression guard for the FTS5 shadow-table discovery defect
 *  (long-horizon audit, 2026-08-04).
 *
 *  A collection creates SEVEN tables: the data table plus an FTS5 companion
 *  and its five shadow tables. All seven match `name LIKE 'collection_mail_%'`
 *  and only one has `record_id` / `received_at` / `hot_fields`. Producers that
 *  scanned by LIKE and then selected a data column threw `no such column` on
 *  the first shadow they reached; inside a housekeeping task that throw is
 *  caught, counted, and after three consecutive cycles disables the task for
 *  24 h — so the producer stops emitting FOREVER while the cycle keeps
 *  reporting success.
 *
 *  Two guards, because the behaviour and the footgun are different things:
 *    1. `listCollectionDataTables` returns the data table and nothing else.
 *    2. no module open-codes the loose scan again. */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createCollectionTable, listCollectionDataTables } from '../table.js';

const SRC = new URL('../../', import.meta.url).pathname;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
};

describe('collection data-table discovery', () => {
  it('returns the data table and none of its FTS5 shadow tables', () => {
    const db = new Database(':memory:');
    createCollectionTable({ db, platform: 'mail', slug: 'work' });
    createCollectionTable({ db, platform: 'mail', slug: 'personal' });

    // Precondition the whole defect rests on: the shadows EXIST and they do
    // match the loose prefix scan. If this ever stops being true the guard
    // below is passing for the wrong reason.
    const looseScan = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type='table' AND name LIKE 'collection_mail_%'`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(looseScan.length).toBeGreaterThan(2);
    expect(looseScan.some((n) => n.includes('_fts'))).toBe(true);

    const discovered = listCollectionDataTables(db, 'mail');
    expect(discovered).toHaveLength(2);
    for (const name of discovered) {
      expect(name).toMatch(/^collection_mail_[0-9a-f]{10}$/);
      // The property that actually matters: every returned table can be
      // queried for the columns a producer reads.
      expect(() =>
        db.prepare(`SELECT record_id, received_at, hot_fields FROM "${name}"`).all(),
      ).not.toThrow();
    }
    db.close();
  });

  it('is scoped to the requested platform', () => {
    const db = new Database(':memory:');
    createCollectionTable({ db, platform: 'mail', slug: 'work' });
    createCollectionTable({ db, platform: 'file', slug: 'docs' });
    expect(listCollectionDataTables(db, 'mail')).toHaveLength(1);
    expect(listCollectionDataTables(db, 'file')).toHaveLength(1);
    expect(listCollectionDataTables(db, 'webhook')).toHaveLength(0);
    db.close();
  });

  it('no module open-codes a collection-prefix sqlite_master scan', () => {
    // ⛔ The footgun guard. Fixing twenty-two call sites is worth nothing if
    // the twenty-third is written next week. A prefix scan over
    // `collection_<platform>_` is only ever correct when the result is
    // narrowed to the exact data-table shape, so route it through the helper.
    //
    // Two files are allowed to keep their own scan, for stated reasons:
    //   - table.ts            — it IS the helper
    //   - collection-blob-refs — scans EVERY platform and structurally probes
    //                            for a `blob_hash` column before querying, so
    //                            shadows are excluded by a different (and
    //                            deliberate) mechanism
    const allowed = new Set(['collections/table.ts', 'storage/collection-blob-refs.ts']);

    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length);
      if (allowed.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      if (!text.includes('sqlite_master')) continue;
      // Literal prefix scan, and the parameterised spelling that a plain grep
      // for `LIKE 'collection_` misses entirely (behavioral_signature.ts was
      // exactly that, and only a type error surfaced it).
      const literal = /name LIKE 'collection_[a-z]+_%'/.test(text);
      const parameterised =
        /`collection_\$\{[^}]+\}_`/.test(text) && /name LIKE \?/.test(text);
      if (literal || parameterised) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
