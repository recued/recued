/** A pre-update snapshot is durable before it is named, and its hash does not
 *  stop at 2 GiB.
 *
 *  ⛔ The snapshot copy fsynced nothing, while the binary swap fsyncs every
 *  rename. A power loss soon after could leave a snapshot whose name survived
 *  and whose bytes did not, and a later revert copies the snapshot over the
 *  live database.
 *
 *  ⛔ The rollback journal hashed with `readFileSync`, which Node refuses past
 *  2 GiB, so the owner's rollback of a release that migrated a database over
 *  2 GiB was refused with "could not hash the rollback database snapshot". */
import { closeSync, existsSync, ftruncateSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

const durable = vi.hoisted(() => ({ calls: [] as Array<[string, string, boolean]> }));
vi.mock('../durable-fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../durable-fs.js')>();
  return {
    ...actual,
    fsyncFile: (path: string) => { durable.calls.push(['file', path, existsSync(path)]); actual.fsyncFile(path); },
    fsyncDir: (path: string) => { durable.calls.push(['dir', path, existsSync(path)]); actual.fsyncDir(path); },
  };
});

const { copyClosedDatabaseForSnapshot, copyDatabaseForSnapshot } = await import('../open-database.js');
const { sha256File } = await import('../update/manual-rollback-journal.js');

const dirs: string[] = [];
const dir = (): string => { const d = mkdtempSync(join(tmpdir(), 'recued-snapshot-durable-')); dirs.push(d); return d; };
afterEach(() => {
  durable.calls.length = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('a pre-update snapshot is durable before it is named', () => {
  it('⛔ the copy of a closed database: bytes flushed under the staging name, then the rename', async () => {
    const root = dir();
    const dbPath = join(root, 'r.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'row\')');
    db.close();
    const destination = join(root, 'r.db.update-snapshot');
    await copyClosedDatabaseForSnapshot(dbPath, destination);
    const [file, dirSync] = durable.calls;
    expect(file?.[0]).toBe('file');
    expect(file?.[1]).not.toBe(destination);         // the staging copy, not yet named
    expect(file?.[2]).toBe(true);
    expect(dirSync).toEqual(['dir', dirname(destination), true]);
    expect(existsSync(destination)).toBe(true);
  });

  it('⛔ the VACUUM INTO copy of an open database: the same', async () => {
    const root = dir();
    const db = new Database(join(root, 'r.db'));
    db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'row\')');
    const destination = join(root, 'r.db.update-snapshot');
    await copyDatabaseForSnapshot(db, destination);
    db.close();
    expect(durable.calls.map(([kind]) => kind)).toEqual(['file', 'dir']);
    expect(durable.calls[0]![1]).not.toBe(destination);
    expect(durable.calls[1]![1]).toBe(dirname(destination));
  });
});

describe('the rollback hash streams', () => {
  it('⛔ hashes a file past 2 GiB, which a single read refuses', () => {
    const path = join(dir(), 'big.db');
    const fd = openSync(path, 'w');
    ftruncateSync(fd, 2_200_000_000);               // sparse: no real disk used
    closeSync(fd);
    expect(sha256File(path)).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);
});
