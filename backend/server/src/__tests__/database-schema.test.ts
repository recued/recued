import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertArchiveDatabaseSchema, DATABASE_MIGRATIONS, DATABASE_SCHEMA_VERSION,
  migrateDatabaseSchema, readDatabaseSchema, type DatabaseMigration,
} from '../database-schema.js';
import { openDatabase } from '../open-database.js';
import { processFixtureMigrations } from './helpers/database-schema-child.js';

const dirs: string[] = [];
const handles: Database.Database[] = [];
const children: ChildProcess[] = [];
const fixture = (): { dir: string; path: string; db: Database.Database } => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-schema-'));
  dirs.push(dir);
  const path = join(dir, 'realm.db');
  const db = new Database(path);
  handles.push(db);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE owner_data (value INTEGER NOT NULL); INSERT INTO owner_data VALUES (7)');
  return { dir, path, db };
};
const waitForFile = async (path: string): Promise<void> => {
  const deadline = Date.now() + 15000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error('Owned child did not reach its schema barrier');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const startChild = (path: string, mode: string, marker: string, release: string) => {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./helpers/database-schema-child.ts', import.meta.url)), path, mode, marker, release],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGKILL') reject(new Error('Schema fixture child failed: ' + stderr));
      else resolve({ code, signal });
    });
  });
  void done.catch(() => {}); // Teardown still awaits the original failure.
  return { child, done };
};
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }
  }));
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('stored database schema and ordered upgrades', () => {
  it('adopts a legacy trigger layout without changing owner rows and reopens idempotently', async () => {
    const { path, db } = fixture();
    db.exec(`CREATE TABLE event_triggers (
      trigger_id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, publisher_id TEXT NOT NULL,
      pattern TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
      last_fired_at INTEGER, last_error TEXT);
      INSERT INTO event_triggers VALUES ('t', 'r', 'p', 'mail.*', 0, 5, 6, 'preserve')`);
    expect(readDatabaseSchema(db)).toMatchObject({ stored_version: 0, version: 2 });
    expect(migrateDatabaseSchema(db, DATABASE_MIGRATIONS, () => 123)).toEqual({ from_version: 2, to_version: 3, applied: [3] });
    expect(db.prepare('SELECT * FROM event_triggers').get()).toMatchObject({
      trigger_id: 't', enabled: 0, last_fired_at: 6, last_error: 'preserve', origin: 'user', read_contract_id: null,
    });
    const before = readDatabaseSchema(db);
    expect(before.migrations).toHaveLength(1);
    expect(before.migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
    db.close();
    const reopened = await openDatabase(path, { writeLockWarning: false });
    handles.push(reopened);
    expect(migrateDatabaseSchema(reopened, DATABASE_MIGRATIONS, () => 999).applied).toEqual([]);
    expect(readDatabaseSchema(reopened)).toEqual(before);
    expect(reopened.prepare('SELECT value FROM owner_data').get()).toEqual({ value: 7 });
  });

  it('commits the same baseline on an empty database and restores connection settings', () => {
    const db = new Database(':memory:'); handles.push(db);
    db.pragma('synchronous = NORMAL');
    expect(migrateDatabaseSchema(db).to_version).toBe(DATABASE_SCHEMA_VERSION);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.prepare('SELECT count(*) n FROM event_triggers').get()).toEqual({ n: 0 });
  });

  it('rolls back failed DDL, row changes, the receipt and version together', () => {
    const { db } = fixture();
    migrateDatabaseSchema(db);
    const catalog: DatabaseMigration[] = [...DATABASE_MIGRATIONS, { version: 4, id: 'fixture-failure', statements: [
      { sql: 'ALTER TABLE owner_data ADD COLUMN unintended TEXT' },
      { sql: 'UPDATE owner_data SET value = 99' },
      { sql: 'INSERT INTO missing_table VALUES (1)' },
    ] }];
    expect(() => migrateDatabaseSchema(db, catalog)).toThrow(/missing_table/);
    expect(readDatabaseSchema(db).version).toBe(3);
    expect(db.prepare('SELECT * FROM owner_data').get()).toEqual({ value: 7 });
    expect(db.prepare('SELECT count(*) n FROM database_schema_migrations').get()).toEqual({ n: 1 });
    expect(db.inTransaction).toBe(false);
  });

  it.each(['missing receipt', 'changed checksum', 'extra receipt', 'legacy journal'])('refuses %s without repairing evidence', kind => {
    const { db } = fixture(); migrateDatabaseSchema(db);
    if (kind === 'missing receipt') db.exec('DELETE FROM database_schema_migrations');
    if (kind === 'changed checksum') db.exec("UPDATE database_schema_migrations SET checksum='tampered'");
    if (kind === 'extra receipt') db.exec("INSERT INTO database_schema_migrations VALUES (4, 'unknown', 'unknown', 1)");
    if (kind === 'legacy journal') db.pragma('user_version = 0');
    const before = db.prepare('SELECT * FROM database_schema_migrations').all();
    expect(() => migrateDatabaseSchema(db)).toThrow(/DATABASE_SCHEMA_INVALID/);
    expect(db.prepare('SELECT * FROM database_schema_migrations').all()).toEqual(before);
  });

  it('refuses a version whose journal disappeared', () => {
    const { db } = fixture(); db.pragma('user_version = 3');
    expect(() => readDatabaseSchema(db)).toThrow(/no migration journal/);
  });

  it('refuses gaps, duplicate ids, nested transactions and unsafe on-disk journaling before migration', () => {
    const { db } = fixture();
    expect(() => migrateDatabaseSchema(db, [{ version: 4, id: 'gap', statements: [] }])).toThrow(/catalog/);
    expect(() => migrateDatabaseSchema(db, [...DATABASE_MIGRATIONS, { version: 4, id: DATABASE_MIGRATIONS[0]!.id, statements: [] }])).toThrow(/catalog/);
    expect(() => db.transaction(() => migrateDatabaseSchema(db))()).toThrow(/outside a transaction/);
    expect(db.pragma('journal_mode = MEMORY', { simple: true })).toBe('memory');
    expect(() => migrateDatabaseSchema(db)).toThrow(/durable SQLite journal/);
    expect(db.pragma('user_version', { simple: true })).toBe(0);
  });

  it('refuses newer databases through the shared open and permits only explicit read-only inspection', async () => {
    const { db, path } = fixture(); db.pragma('user_version = 99'); db.close();
    const before = readFileSync(path);
    await expect(openDatabase(path)).rejects.toThrow(/DATABASE_SCHEMA_TOO_NEW/);
    await expect(openDatabase(path, { allowNewerSchema: true })).rejects.toThrow(/requires readonly/);
    const mutableOptions = { databaseKey: null, allowNewerSchema: false };
    const pending = openDatabase(path, mutableOptions).then(handle => { handles.push(handle); return handle; });
    mutableOptions.allowNewerSchema = true;
    await expect(pending).rejects.toThrow(/DATABASE_SCHEMA_TOO_NEW/);
    const probe = await openDatabase(path, { readonly: true, allowNewerSchema: true }); handles.push(probe);
    expect(probe.prepare('SELECT value FROM owner_data').get()).toEqual({ value: 7 });
    expect(() => probe.exec('DELETE FROM owner_data')).toThrow(/readonly/);
    expect(readFileSync(path)).toEqual(before);
  });

  it('preserves encrypted databases while migrating and reopening', async () => {
    const { db, path } = fixture(); db.close(); rmSync(path);
    const key = new Uint8Array(32).fill(71);
    const encrypted = await openDatabase(path, { databaseKey: key, writeLockWarning: false }); handles.push(encrypted);
    encrypted.exec("CREATE TABLE private_rows (body TEXT); INSERT INTO private_rows VALUES ('private migration fixture')");
    migrateDatabaseSchema(encrypted); encrypted.close();
    expect(readFileSync(path).includes(Buffer.from('private migration fixture'))).toBe(false);
    const reopened = await openDatabase(path, { databaseKey: key, writeLockWarning: false }); handles.push(reopened);
    expect(readDatabaseSchema(reopened).version).toBe(3);
    expect(reopened.prepare('SELECT body FROM private_rows').get()).toEqual({ body: 'private migration fixture' });
  });

  it('checks stored versions against archive manifests while preserving genuinely unversioned archives', () => {
    const { db } = fixture();
    expect(() => assertArchiveDatabaseSchema(db, 1)).not.toThrow();
    expect(() => assertArchiveDatabaseSchema(db, 2)).not.toThrow();
    expect(() => assertArchiveDatabaseSchema(db, 3)).toThrow(/ARCHIVE_SCHEMA_MISMATCH/);
    migrateDatabaseSchema(db);
    expect(() => assertArchiveDatabaseSchema(db, 3)).not.toThrow();
    expect(() => assertArchiveDatabaseSchema(db, 2)).toThrow(/ARCHIVE_SCHEMA_MISMATCH/);
    expect(() => assertArchiveDatabaseSchema(db, NaN)).toThrow(/invalid/);
  });

  it('recovers after SIGKILL inside a later migration, preserving completed steps and retrying only the interrupted one', async () => {
    const { db, path, dir } = fixture(); db.close();
    const marker = join(dir, 'crash'); const release = join(dir, 'release');
    const writer = startChild(path, 'crash', marker, release);
    await waitForFile(marker);
    writer.child.kill('SIGKILL');
    expect((await writer.done).signal).toBe('SIGKILL');
    const recovered = new Database(path); handles.push(recovered);
    const catalog = processFixtureMigrations('crash', false);
    expect(readDatabaseSchema(recovered, catalog).version).toBe(4);
    expect(recovered.prepare('SELECT * FROM owner_data').get()).toEqual({ value: 8 });
    const completed = recovered.prepare('SELECT * FROM database_schema_migrations').all();
    expect(migrateDatabaseSchema(recovered, catalog).applied).toEqual([5]);
    expect(recovered.prepare('SELECT * FROM owner_data').get()).toEqual({ value: 18, recovered: null });
    expect(recovered.prepare('SELECT * FROM database_schema_migrations WHERE version < 5').all()).toEqual(completed);
    expect(migrateDatabaseSchema(recovered, catalog).applied).toEqual([]);
  }, 25000);

  it('serializes independent upgrading processes and applies a non-idempotent step exactly once', async () => {
    const { db, path, dir } = fixture(); db.close();
    const firstMarker = join(dir, 'first'); const secondMarker = join(dir, 'second'); const release = join(dir, 'release');
    const first = startChild(path, 'concurrent', firstMarker, release);
    await waitForFile(firstMarker);
    const second = startChild(path, 'concurrent', secondMarker, release);
    await waitForFile(secondMarker + '.attempt');
    writeFileSync(release, 'release');
    await Promise.all([first.done, second.done]);
    const probe = new Database(path); handles.push(probe);
    expect(probe.prepare('SELECT value FROM owner_data').get()).toEqual({ value: 8 });
    expect(JSON.parse(readFileSync(firstMarker + '.result', 'utf8')).applied).toEqual([3, 4]);
    expect(JSON.parse(readFileSync(secondMarker + '.result', 'utf8')).applied).toEqual([]);
    expect(existsSync(secondMarker)).toBe(false);
  }, 25000);
});
