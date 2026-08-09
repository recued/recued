/** A schema dump taken from a WAL-mode server keeps what is still in the WAL.
 *
 *  ⛔ THE DEFECT. `dump-schema.ts` boots the real server — explicitly, because
 *  the bench seed is missing tables that only exist after migrations, and "a
 *  sweep whose denominator quietly excludes whole subsystems is worse than no
 *  sweep" — and then copied the database with a bare `copyFileSync`. The server
 *  runs in WAL mode, so everything since the last checkpoint sits in `<db>-wal`.
 *  Measured on a real boot: 808 `sqlite_master` objects live, 623 in the dump.
 *
 *  ⛔ WHICH MADE THE SQL AUDIT REPORT INDEXES THAT EXIST AS MISSING. Two indexes
 *  created at store construction were absent from the dump, so the queries using
 *  them EXPLAINed as full scans — a false positive that `index-advisor.ts` would
 *  turn into a proposal to build a duplicate. It was found the only way it could
 *  be: by dumping the schema and looking for something known to be there.
 *
 *  🔑 THE KNOWN-NEGATIVE IS THE POINT. Every case below asserts the OLD copy
 *  loses the row and the NEW copy keeps it. Without the negative half, a test
 *  that merely finds the table proves nothing — SQLite checkpoints on close, so
 *  a fixture that tears its connection down first passes either way. */

import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { copyDatabaseSnapshot } from '../../scripts/horizon-audit/copy-db-snapshot.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** A WAL-mode database with uncheckpointed DDL, left OPEN — the state a running
 *  server is in when `dump-schema.ts` copies it. */
const liveWalDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wal-snap-'));
  dirs.push(dir);
  const path = join(dir, 'live.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE early (v TEXT)');
  db.pragma('wal_checkpoint(TRUNCATE)');   // `early` is now in the main file
  // Everything past this point stays in the WAL until a checkpoint.
  db.exec('CREATE TABLE late (v TEXT)');
  db.exec("CREATE INDEX idx_late_v ON late (v)");
  db.exec('CREATE TABLE user_memory (key TEXT PRIMARY KEY, data TEXT)');
  db.exec("CREATE INDEX idx_win ON user_memory (COALESCE(json_extract(data, '$.event_at'), json_extract(data, '$.ts')) DESC)");
  return { dir, path, db };
};

const objectsIn = (path: string): string[] => {
  const read = new Database(path, { readonly: true });
  const rows = read.prepare(
    `SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all() as Array<{ name: string }>;
  read.close();
  return rows.map((r) => r.name);
};

describe('horizon schema-dump snapshot', () => {
  it('⛔ KNOWN NEGATIVE: a bare file copy loses everything still in the WAL', () => {
    // Proves the fixture actually holds uncheckpointed writes. Without this the
    // positive case below could pass against a database that had nothing in its
    // WAL to lose.
    const { dir, path, db } = liveWalDb();
    const out = join(dir, 'bare.db');
    copyFileSync(path, out);

    const names = objectsIn(out);
    expect(names).toContain('early');          // checkpointed, so it survives
    expect(names).not.toContain('late');       // ...and the rest does not
    expect(names).not.toContain('idx_win');
    db.close();
  });

  it('⛔ the snapshot copy keeps the uncheckpointed tables AND indexes', () => {
    const { dir, path, db } = liveWalDb();
    const out = join(dir, 'snap.db');
    copyDatabaseSnapshot(path, out);

    const names = objectsIn(out);
    for (const n of ['early', 'late', 'idx_late_v', 'user_memory', 'idx_win']) {
      expect(names, `${n} missing from the snapshot`).toContain(n);
    }
    db.close();
  });

  it('⛔ loses nothing at all — the object sets are IDENTICAL', () => {
    // The property the named-object checks only sample. This is the assertion
    // the audit's denominator actually depends on.
    const { dir, path, db } = liveWalDb();
    const out = join(dir, 'full.db');
    copyDatabaseSnapshot(path, out);
    expect(objectsIn(out)).toEqual(objectsIn(path));
    db.close();
  });

  it('⛔ a STALE sidecar from a previous dump is cleared, not inherited', () => {
    // Writing over an existing destination while leaving its `-wal` behind is
    // how a reader gets a schema that never existed: the main file from run B
    // replayed against the WAL from run A.
    const { dir, path, db } = liveWalDb();
    const out = join(dir, 'reused.db');
    writeFileSync(`${out}-wal`, 'garbage from an earlier dump');
    copyDatabaseSnapshot(path, out);
    expect(objectsIn(out)).toEqual(objectsIn(path));
    db.close();
  });

  it('a source with no WAL sidecar copies cleanly', () => {
    // The non-WAL case (a checkpointed or journal-mode database) must not
    // acquire an empty sidecar or throw.
    const dir = mkdtempSync(join(tmpdir(), 'wal-snap-plain-'));
    dirs.push(dir);
    const path = join(dir, 'plain.db');
    const db = new Database(path);
    db.exec('CREATE TABLE t (v TEXT)');
    db.close();                       // journal mode default; no -wal left

    const out = join(dir, 'copy.db');
    closeSync(openSync(`${out}-wal`, 'w'));   // a leftover from before
    copyDatabaseSnapshot(path, out);

    expect(objectsIn(out)).toEqual(['t']);
    expect(existsSync(`${out}-wal`), 'a sidecar with no source must not survive').toBe(false);
  });
});
