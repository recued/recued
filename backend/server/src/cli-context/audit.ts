import Database from 'better-sqlite3';
import {
  createAuditLogStore,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';
import { getArg, parsePositionals } from '../cli/parse.js';
import type { BootTrace } from '../cli/boot-trace.js';
import { cmdAudit } from '../commands/audit.js';
import { ensureAuditIndexes } from '../audit-indexes.js';
import { createSQLiteCollection } from '../sqlite-collection.js';

export interface AuditProfileOptions {
  args: string[];
  bootTrace?: BootTrace;
  env?: NodeJS.ProcessEnv;
}

export async function runAuditProfile(options: AuditProfileOptions): Promise<void> {
  const env = options.env ?? process.env;
  const positionals = parsePositionals(options.args);
  const target = positionals[1];
  const dbPath = getArg(options.args, 'db') ?? env.DB_PATH ?? './recued-server.db';

  options.bootTrace?.markDbOpenAttempted('configured-db-path');
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    options.bootTrace?.mark('db-opened');

    const auditLog = createAuditLogStore(
      createSQLiteCollection<AuditEntry>(db, 'audit_entries'),
      createSQLiteCollection<ActivityEntry>(db, 'audit_activities'),
    );
    ensureAuditIndexes(db);

    await cmdAudit({ auditLog }, target);
  } finally {
    db.close();
  }
}
