/** Realm-scoped recovery-key check storage.
 *
 *  The server stores ONE `recovery_key_check` blob per realm — the same
 *  AEAD-sealed sentinel format the extension uses (`buildRecoveryKeyCheck`
 *  on the ext side). First pair enrolls the check; every subsequent
 *  pair (and future recover-pair) verifies the entered key against it.
 *
 *  Persisted in the existing `server_config` SQLite table to keep the
 *  state surface narrow — same table the bundle store and the realm
 *  token already use. No separate file to back up or restore.
 *
 *  This module is pure I/O. The crypto (KDF + AEAD) lives in the
 *  caller (the register handler), which uses `@recued/crypto`'s
 *  `deriveKEKFromRecoveryKey` + the shared sentinel constant.
 */

import type Database from 'better-sqlite3';

const RECOVERY_CHECK_KEY = 'recovery_key_check';

export interface RecoveryKeyCheckStore {
  /** Read the stored check blob, or null when no check is enrolled
   *  on this realm yet. */
  read(): string | null;
  /** Persist the check blob (overwrites any prior value — used only
   *  during first-time enrollment; verify is non-destructive). */
  write(blob: string): void;
  /** True when a check is enrolled on this realm. */
  exists(): boolean;
  /** Clear the stored check. Used by factory-reset / re-pair flows
   *  on the operator side; never invoked by a remote client. */
  clear(): void;
}

export const createRecoveryKeyCheckStore = (
  db: Database.Database,
): RecoveryKeyCheckStore => {
  // Table creation is idempotent — bundle-store ensures it exists too,
  // but doing it here keeps this module independently constructable.
  db.exec(`CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  return {
    read() {
      const row = db.prepare(`SELECT value FROM server_config WHERE key = ?`).get(RECOVERY_CHECK_KEY) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },

    write(blob) {
      db.prepare(`INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`)
        .run(RECOVERY_CHECK_KEY, blob);
    },

    exists() {
      const row = db.prepare(`SELECT 1 FROM server_config WHERE key = ?`).get(RECOVERY_CHECK_KEY);
      return row !== undefined;
    },

    clear() {
      db.prepare(`DELETE FROM server_config WHERE key = ?`).run(RECOVERY_CHECK_KEY);
    },
  };
};
