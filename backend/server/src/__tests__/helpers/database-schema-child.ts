/** Owned process fixtures: block inside a real SQLite migration so the parent
 * can kill a writer or arrange a second writer behind its transaction. */
import Database from 'better-sqlite3';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATABASE_MIGRATIONS, migrateDatabaseSchema, type DatabaseMigration } from '../../database-schema.js';

export const processFixtureMigrations = (mode: 'crash' | 'concurrent', barrier: boolean): DatabaseMigration[] => [
  ...DATABASE_MIGRATIONS,
  { version: 4, id: 'fixture-004-committed', statements: [
    { sql: 'UPDATE owner_data SET value = value + 1' },
    ...(mode === 'concurrent' ? [{ sql: barrier ? 'SELECT migration_barrier()' : 'SELECT 1' }] : []),
  ] },
  ...(mode === 'crash' ? [{ version: 5, id: 'fixture-005-interrupted', statements: [
    { sql: 'ALTER TABLE owner_data ADD COLUMN recovered TEXT' },
    { sql: 'UPDATE owner_data SET value = value + 10' },
    { sql: barrier ? 'SELECT migration_barrier()' : 'SELECT 1' },
  ] }] : []),
];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [path, mode, marker, release] = process.argv.slice(2);
  if (!path || (mode !== 'crash' && mode !== 'concurrent') || !marker || !release) throw new Error('Invalid owned schema fixture arguments');
  const db = new Database(path);
  db.pragma('busy_timeout = 15000');
  db.function('migration_barrier', () => {
    writeFileSync(marker, 'inside');
    const deadline = Date.now() + 20000;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(release)) {
      if (Date.now() > deadline) throw new Error('Owned schema barrier timed out');
      Atomics.wait(wait, 0, 0, 20);
    }
    return 1;
  });
  try {
    writeFileSync(marker + '.attempt', 'attempt');
    const result = migrateDatabaseSchema(db, processFixtureMigrations(mode, true));
    writeFileSync(marker + '.result', JSON.stringify(result));
  } finally { db.close(); }
}
