/** Two processes write one realm file: the server, and each `recued --mcp`
 *  (Claude Desktop starts one per session). SQLite makes a writer WAIT for the
 *  other's write lock, up to the driver's 5 s busy timeout — except when a
 *  DEFERRED transaction has already read. Upgrading that read to a write skips
 *  the busy handler (to avoid deadlock), so it fails "database is locked" in
 *  0-1 ms. Measured 2026-10-10 with this driver: a plain write waited 5.2 s, a
 *  read-then-write deferred transaction failed after 1 ms.
 *
 *  `d-261-boot`'s stdio leg died of exactly that on 2026-10-09 and 2026-10-10,
 *  and both times it was put down to suite load: every `--mcp` start ran three
 *  such transactions (`grandfatherPrimitiveGrants` through
 *  `contractStore.transaction`, and the `seller_tiers` converge twice), and the
 *  server's own start runs the same ones.
 *
 *  Each case holds the realm's write lock from ANOTHER PROCESS, proves the lock
 *  is held at the moment of the call, and runs a startup step that must write.
 *  It has to wait and then succeed. On the old code each one threw
 *  SQLITE_BUSY immediately. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../open-database.js';
import {
  grandfatherPrimitiveGrants,
  PRIMITIVE_GRANDFATHER_SERVER_KEY,
} from '../owner-grant-reconcile.js';
import { createContractStore } from '../storage/contract-store.js';
import { ensureSellerSchema, SELLER_TIERS_TABLE } from '../storage/seller-store.js';
import { expectWriteLockHeldElsewhere, holdWriteLock } from './helpers/realm-write-lock-holder.js';

const dirs: string[] = [];
const dbs: Database.Database[] = [];

const openRealm = async (): Promise<{ file: string; db: Database.Database }> => {
  const dir = mkdtempSync(join(tmpdir(), 'realm-write-lock-'));
  dirs.push(dir);
  const file = join(dir, 'realm.db');
  const db = await openDatabase(file, { databaseKey: null });
  db.pragma('journal_mode = WAL');
  dbs.push(db);
  return { file, db };
};

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a realm connection takes the write lock first (`openDatabase`)', () => {
  // The shape an audit of the test suite found in 85 production places: read,
  // then write, in one transaction.
  const readThenWrite = (db: Database.Database) => db.transaction(() => {
    const row = db.prepare(`SELECT v FROM t WHERE k = 'a'`).get() as { v: string };
    db.prepare(`UPDATE t SET v = ? WHERE k = 'a'`).run(`${row.v}+`);
  });

  const seeded = async (): Promise<{ file: string; db: Database.Database }> => {
    const realm = await openRealm();
    realm.db.exec(`CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)`);
    realm.db.prepare(`INSERT INTO t VALUES ('a', '1')`).run();
    return realm;
  };

  it('a read-then-write transaction waits for another process, then writes', async () => {
    const { file, db } = await seeded();
    const holder = await holdWriteLock(file, 1_500);
    await expectWriteLockHeldElsewhere(file);

    expect(() => readThenWrite(db)()).not.toThrow();
    await holder.released;
    expect(db.prepare(`SELECT v FROM t WHERE k = 'a'`).get()).toEqual({ v: '1+' });
  });

  it('.deferred() is still the driver default, and fails at once: the opt-out is real', async () => {
    const { file, db } = await seeded();
    const holder = await holdWriteLock(file, 1_500);
    await expectWriteLockHeldElsewhere(file);

    expect(() => readThenWrite(db).deferred()).toThrow(/database is locked/);
    await holder.released;
    expect(db.prepare(`SELECT v FROM t WHERE k = 'a'`).get()).toEqual({ v: '1' });
  });

  // ⚠ This pins SQLite, not our code: BEGIN IMMEDIATE on a read-only database
  // opens a READ transaction (`sqlite3BeginTransaction`), which is why
  // `takeWriteLockFirst` needs no exemption for one. Tried: adding one changed
  // nothing here.
  it('a read-only connection still reads while another process writes', async () => {
    const { file } = await seeded();
    const readonly = await openDatabase(file, { databaseKey: null, readonly: true, timeout: 0 });
    dbs.push(readonly);
    const holder = await holdWriteLock(file, 1_500);
    await expectWriteLockHeldElsewhere(file);

    // With a 0 ms timeout, any wait for the write lock would fail right here.
    expect(readonly.transaction(() => readonly.prepare(`SELECT v FROM t`).get())())
      .toEqual({ v: '1' });
    await holder.released;
  });
});

describe('a startup write waits for another process instead of failing on it', () => {
  it('grandfatherPrimitiveGrants (contractStore.transaction) waits, then writes its mark', async () => {
    const { file, db } = await openRealm();
    const contractStore = createContractStore(db);
    // First start on this realm. The second is the steady state every `--mcp`
    // start hit: scan the grandfather scope (a read), then rewrite the mark.
    grandfatherPrimitiveGrants(contractStore, () => 1);
    const holder = await holdWriteLock(file, 1_500);
    await expectWriteLockHeldElsewhere(file);

    expect(() => grandfatherPrimitiveGrants(contractStore, () => 2)).not.toThrow();
    await holder.released;
    // The second start's write landed after the wait (scope literal: the module
    // keeps `PRIMITIVE_GRANDFATHER_SCOPE` private).
    expect(contractStore.get('primitive_grandfather', [PRIMITIVE_GRANDFATHER_SERVER_KEY])?.value)
      .toMatchObject({ grandfathered_at: 2 });
  });

  it('the seller_tiers converge waits, then converges', async () => {
    const { file, db } = await openRealm();
    ensureSellerSchema(db);
    // Put back a CHECK from before `paddle` existed, so the next start must
    // rebuild the table — and that rebuild is then its ONLY write.
    const current = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(SELLER_TIERS_TABLE) as { sql: string }).sql;
    const legacy = current.replace(/'paddle', /, '');
    expect(legacy).not.toBe(current);
    // ⚠ The indexes go with the table and must come back with it. Without them
    // `ensureSellerSchema`'s own `CREATE INDEX IF NOT EXISTS` is a real write
    // that waits out the holder, the converge then runs on a free lock, and this
    // case passed with the converge reverted to deferred. (Caught by doing that.)
    const indexes = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`,
    ).all(SELLER_TIERS_TABLE) as { sql: string }[]).map((row) => row.sql);
    expect(indexes.length).toBeGreaterThan(0);
    db.exec(`DROP TABLE ${SELLER_TIERS_TABLE}`);
    db.exec(legacy);
    for (const sql of indexes) db.exec(sql);
    const holder = await holdWriteLock(file, 1_500);
    await expectWriteLockHeldElsewhere(file);

    expect(() => ensureSellerSchema(db)).not.toThrow();
    await holder.released;
    const after = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(SELLER_TIERS_TABLE) as { sql: string }).sql;
    expect(after).toContain("'paddle'");
  });
});
