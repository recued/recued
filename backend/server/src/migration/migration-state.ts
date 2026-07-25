/** Migration-state persistence — durable marker for the plaintext→encrypted
 *  re-encryption operation.
 *
 *  The marker lives in the existing `server_config` SQLite table under
 *  key 'migration_state'. Its mere presence means the server is in a
 *  maintenance window; ws dispatch blocks non-auth calls while it's set.
 *
 *  Shape is versioned so future migrations (e.g., key rotation or
 *  schema changes) can reuse the same marker pattern without conflicting.
 */

import type Database from 'better-sqlite3';

export type MigrationPhase = 'preparing' | 'cache' | 'blobs' | 'finalizing';

export interface MigrationProgress {
  rowsDone: number;
  rowsTotal: number;
  blobsDone: number;
  blobsTotal: number;
}

export interface MigrationState {
  version: 1;
  /** What the runner is currently doing. Cursor is meaningful during
   *  'blobs'; undefined otherwise. */
  phase: MigrationPhase;
  /** Last successfully migrated blob hash (sorted-ascending). Resume
   *  continues with the next hash > cursor. */
  cursor?: string;
  progress: MigrationProgress;
  startedAt: number;
}

const KEY = 'migration_state';

export interface MigrationStateStore {
  load(): MigrationState | null;
  save(state: MigrationState): void;
  clear(): void;
  exists(): boolean;
}

export const createMigrationStateStore = (db: Database.Database): MigrationStateStore => {
  db.exec(`CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  return {
    load() {
      const row = db.prepare(`SELECT value FROM server_config WHERE key = ?`).get(KEY) as
        | { value: string }
        | undefined;
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.value);
        if (parsed?.version !== 1) return null;
        return parsed as MigrationState;
      } catch {
        return null;
      }
    },

    save(state) {
      db.prepare(`INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`)
        .run(KEY, JSON.stringify(state));
    },

    clear() {
      db.prepare(`DELETE FROM server_config WHERE key = ?`).run(KEY);
    },

    exists() {
      return db.prepare(`SELECT 1 FROM server_config WHERE key = ?`).get(KEY) !== undefined;
    },
  };
};
