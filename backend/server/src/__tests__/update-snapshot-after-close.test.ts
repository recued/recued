/** The pre-migration snapshot is taken AFTER the restart drain closed the
 *  database, so it needs a copy that works without a connection.
 *
 *  ⛔ WHY THERE ARE TWO. `copyDatabaseForSnapshot` runs `VACUUM INTO` ON a
 *  connection — that is what lets it inherit an encrypted realm's cipher, and it
 *  is exactly what is gone by the time the apply commits: the drain's `close_db`
 *  step has run, because a snapshot taken while the server was still ACCEPTING
 *  WRITES excluded every write made between it and the restart. With the last
 *  handle closed SQLite has checkpointed and removed the WAL, so the main file is
 *  the consistent copy and a byte copy is the faithful one.
 *
 *  🔑 THE KNOWN-NEGATIVE IS THE POINT. Asserting only that the new copy has the
 *  rows proves nothing on its own — a plain `copyFileSync` of a CHECKPOINTED file
 *  passes too. Each case pairs it with what the other mechanism does in the same
 *  state. */
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { copyClosedDatabaseForSnapshot, copyDatabaseForSnapshot } from '../open-database.js';
import { realmSnapshotPath } from '../update/realm-generation-snapshot.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** A WAL-mode realm with committed rows, then CLOSED — the state the apply's
 *  commit runs in, after the drain's `close_db` step. */
const closedRealm = (): { path: string; snap: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'closed-snap-'));
  dirs.push(dir);
  const path = join(dir, 'realm.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('written before the drain');
  db.close();
  return { path, snap: realmSnapshotPath(path) };
};

describe('copyClosedDatabaseForSnapshot', () => {
  it('copies a closed realm, rows and all', async () => {
    const { path, snap } = closedRealm();
    await copyClosedDatabaseForSnapshot(path, snap);

    const restored = new Database(snap, { readonly: true });
    try {
      expect(restored.prepare('SELECT v FROM t').all()).toEqual([{ v: 'written before the drain' }]);
    } finally {
      restored.close();
    }
  });

  // ⛔ THE NEGATIVE HALF: the mechanism the apply used to use cannot run here at
  // all. It is not a preference between two copies — moving the snapshot into the
  // drain REQUIRES this one.
  it('…where the VACUUM INTO copy cannot run, because there is no connection', async () => {
    const { path, snap } = closedRealm();
    const db = new Database(path);
    db.close();
    await expect(copyDatabaseForSnapshot(db, snap)).rejects.toThrow();
  });

  // ⛔⛔ A SURVIVING `-wal` MEANS THE PREMISE IS FALSE. SQLite removes it when the
  // LAST connection closes, so one still here says something else holds this
  // realm — and a byte copy would then be missing its committed tail. Refusing is
  // what turns that into a failed apply (binary untouched, operation terminated)
  // rather than a snapshot that silently is not one.
  it('refuses when a non-empty -wal survived the close', async () => {
    const { path, snap } = closedRealm();
    writeFileSync(`${path}-wal`, Buffer.alloc(64, 1));
    await expect(copyClosedDatabaseForSnapshot(path, snap)).rejects.toThrow(/still open/);
  });

  it('tolerates an EMPTY -wal, which is not evidence of a writer', () => {
    const { path, snap } = closedRealm();
    closeSync(openSync(`${path}-wal`, 'w'));
    expect(statSync(`${path}-wal`).size).toBe(0);
    return expect(copyClosedDatabaseForSnapshot(path, snap)).resolves.toBeUndefined();
  });
});
