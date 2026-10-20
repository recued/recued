/** Application schema versions, independent of SQLite's own schema_version.
 * Versions 1/2 predate a stored version. Version 3 adopts them and starts the
 * ordered journal. Store-local legacy convergence remains separate. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { EVENT_TRIGGER_SCHEMA_STATEMENTS } from './database-migrations/003-event-triggers.js';

export const DATABASE_SCHEMA_VERSION = 3;
export const LEGACY_DATABASE_SCHEMA_VERSION = 2;
export const DATABASE_MIGRATION_TABLE = 'database_schema_migrations';

export interface DatabaseMigrationStatement {
  readonly sql: string;
  /** Conditional ALTER for layouts from before the ordered journal. */
  readonly unlessColumn?: { readonly table: string; readonly column: string };
}
export interface DatabaseMigration {
  readonly version: number;
  readonly id: string;
  readonly statements: readonly DatabaseMigrationStatement[];
}
export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [{
  version: 3,
  id: '003-event-trigger-baseline',
  statements: EVENT_TRIGGER_SCHEMA_STATEMENTS.map(statement => ({
    sql: statement.sql,
    ...('column' in statement ? { unlessColumn: { table: 'event_triggers', column: statement.column } } : {}),
  })),
}];

interface AppliedMigration {
  version: number;
  migration_id: string;
  checksum: string;
  applied_at: number;
}
export interface DatabaseSchemaState {
  /** Zero means the archive/database predates stored schema versions. */
  stored_version: number;
  version: number;
  migrations: readonly AppliedMigration[];
}

const invalid = (detail: string): never => { throw new Error(`DATABASE_SCHEMA_INVALID: ${detail}`); };
const checksum = (migration: DatabaseMigration): string => createHash('sha256')
  .update(JSON.stringify({ version: migration.version, id: migration.id, statements: migration.statements }))
  .digest('hex');

const validateCatalog = (migrations: readonly DatabaseMigration[]): number => {
  if (migrations.length === 0) return invalid('migration catalog must include the baseline');
  const ids = new Set<string>();
  let version = LEGACY_DATABASE_SCHEMA_VERSION;
  for (const migration of migrations) {
    if (migration.version !== version + 1 || !migration.id || ids.has(migration.id)) {
      return invalid('migration catalog is not a unique, consecutive sequence');
    }
    ids.add(migration.id);
    version = migration.version;
  }
  return version;
};

export const readStoredDatabaseSchemaVersion = (db: Database.Database): number => {
  const version: unknown = db.pragma('main.user_version', { simple: true });
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    return invalid('stored version is not a non-negative integer');
  }
  return version;
};

/** Read-only validation. Never infer an applied migration from a table's shape
 * or repair a missing journal: version and receipts must agree exactly. */
const readDatabaseSchemaSnapshot = (
  db: Database.Database,
  migrations: readonly DatabaseMigration[] = DATABASE_MIGRATIONS,
): DatabaseSchemaState => {
  const supported = validateCatalog(migrations);
  const stored_version = readStoredDatabaseSchemaVersion(db);
  if (stored_version > supported) {
    throw new Error(`DATABASE_SCHEMA_TOO_NEW: database schema ${stored_version} exceeds this server's ${supported}; upgrade the server before opening it`);
  }
  const hasJournal = !!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(DATABASE_MIGRATION_TABLE);
  if (stored_version <= LEGACY_DATABASE_SCHEMA_VERSION) {
    if (hasJournal) return invalid('a legacy database unexpectedly carries a migration journal');
    return { stored_version, version: stored_version || LEGACY_DATABASE_SCHEMA_VERSION, migrations: [] };
  }
  if (!hasJournal) return invalid('stored version has no migration journal');
  const expected = migrations.filter(migration => migration.version <= stored_version);
  const rows = db.prepare(`SELECT version, migration_id, checksum, applied_at FROM ${DATABASE_MIGRATION_TABLE} ORDER BY version LIMIT ?`).all(expected.length + 1) as AppliedMigration[];
  if (rows.length !== expected.length) return invalid('migration journal has missing or extra receipts');
  for (let i = 0; i < expected.length; i++) {
    const migration = expected[i]!;
    const row = rows[i]!;
    if (row.version !== migration.version || row.migration_id !== migration.id
      || row.checksum !== checksum(migration) || !Number.isSafeInteger(row.applied_at) || row.applied_at < 0) {
      return invalid(`migration receipt does not match version ${migration.version}`);
    }
  }
  return { stored_version, version: stored_version, migrations: rows };
};

/** Keep the version and its receipts in the same read snapshot, including
 * while another process commits the next migration. */
export const readDatabaseSchema = (
  db: Database.Database,
  migrations: readonly DatabaseMigration[] = DATABASE_MIGRATIONS,
): DatabaseSchemaState => db.inTransaction
  ? readDatabaseSchemaSnapshot(db, migrations)
  : db.transaction(() => readDatabaseSchemaSnapshot(db, migrations)).deferred();

export const applyDatabaseMigrationStatements = (
  db: Database.Database,
  statements: readonly DatabaseMigrationStatement[],
): void => {
  for (const statement of statements) {
    if (statement.unlessColumn) {
      const { table, column } = statement.unlessColumn;
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) return invalid('invalid migration table name');
      const columns = db.prepare(`PRAGMA main.table_info("${table}")`).all() as Array<{ name: string }>;
      if (columns.some(item => item.name === column)) continue;
    }
    db.exec(statement.sql);
  }
};

/** Each step, its receipt and user_version share one IMMEDIATE transaction.
 * SQLite rolls back an interrupted step; the next boot resumes at the first
 * missing receipt. Completed steps are never replayed or downgraded. */
export const migrateDatabaseSchema = (
  db: Database.Database,
  migrations: readonly DatabaseMigration[] = DATABASE_MIGRATIONS,
  now: () => number = Date.now,
): { from_version: number; to_version: number; applied: number[] } => {
  const target = validateCatalog(migrations);
  if (db.readonly || db.inTransaction) throw new Error('DATABASE_SCHEMA_UPGRADE_REFUSED: migrations require a writable connection outside a transaction');
  const initial = readDatabaseSchema(db, migrations);
  const applied: number[] = [];
  if (initial.version === target) return { from_version: initial.version, to_version: target, applied };
  const journalMode = String(db.pragma('journal_mode', { simple: true })).toLowerCase();
  if (journalMode === 'off' || (journalMode === 'memory' && db.name !== ':memory:')) {
    throw new Error('DATABASE_SCHEMA_UPGRADE_REFUSED: on-disk migrations require a durable SQLite journal');
  }
  const synchronous = Number(db.pragma('synchronous', { simple: true }));
  try {
    db.pragma('synchronous = FULL');
    for (const migration of migrations) {
      db.transaction(() => {
        // Another writer may have completed this step while we waited for the
        // lock. Inspect the committed version only after acquiring it.
        const current = readDatabaseSchema(db, migrations);
        if (current.version >= migration.version) return;
        db.exec(`CREATE TABLE IF NOT EXISTS ${DATABASE_MIGRATION_TABLE} (
          version INTEGER PRIMARY KEY,
          migration_id TEXT NOT NULL UNIQUE,
          checksum TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        )`);
        applyDatabaseMigrationStatements(db, migration.statements);
        const appliedAt = now();
        if (!Number.isSafeInteger(appliedAt) || appliedAt < 0) return invalid('invalid migration timestamp');
        db.prepare(`INSERT INTO ${DATABASE_MIGRATION_TABLE} VALUES (?, ?, ?, ?)`).run(
          migration.version, migration.id, checksum(migration), appliedAt,
        );
        db.pragma(`main.user_version = ${migration.version}`);
        readDatabaseSchema(db, migrations);
        applied.push(migration.version);
      }).immediate();
    }
  } finally {
    db.pragma(`synchronous = ${synchronous}`);
  }
  return { from_version: initial.version, to_version: readDatabaseSchema(db, migrations).version, applied };
};

/** Old archives had no stored version to compare. New archives must name the
 * exact version in their authenticated SQLite payload, including future ones
 * inspected read-only for a compatibility preview. */
export const assertArchiveDatabaseSchema = (db: Database.Database, manifestVersion: number): void => {
  if (!Number.isSafeInteger(manifestVersion) || manifestVersion < 1) return invalid('archive schema version is invalid');
  const stored = readStoredDatabaseSchemaVersion(db);
  if (stored === 0 && manifestVersion <= LEGACY_DATABASE_SCHEMA_VERSION) {
    readDatabaseSchema(db);
    return;
  }
  if (stored !== manifestVersion) {
    throw new Error(`ARCHIVE_SCHEMA_MISMATCH: manifest schema ${manifestVersion} disagrees with database schema ${stored}`);
  }
  if (stored <= DATABASE_SCHEMA_VERSION) readDatabaseSchema(db);
};

if (validateCatalog(DATABASE_MIGRATIONS) !== DATABASE_SCHEMA_VERSION) {
  invalid('migration catalog and server schema version disagree');
}
