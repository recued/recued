/** Server vault bundle persistence — wraps the `server_config` SQLite
 *  table, mirroring `bundle-store.ts`.
 *
 *  The server stores ONE `server_vault_bundle` blob per realm: the
 *  Master DEK dual-wrapped under the server key (keyfile) and the
 *  recovery key (`@recued/crypto`'s `ServerBundle`). First-boot
 *  enrollment writes it; every subsequent boot auto-unlocks the Master
 *  DEK from it using the keyfile-held server key.
 *
 *  Deliberately SEPARATE from the keyfile: the bundle lives in the db
 *  (captured by a db backup) while the server key lives in the `0600`
 *  keyfile. A backup of the db alone therefore stays encrypted — only
 *  the recovery key opens it. This module is pure I/O; all crypto lives
 *  in `@recued/crypto`.
 */

import type Database from 'better-sqlite3';
import {
  serverBundleToJSON,
  serverBundleFromJSON,
  type ServerBundle,
} from '@recued/crypto';

const SERVER_BUNDLE_KEY = 'server_vault_bundle';

export interface ServerBundleStore {
  /** Read the stored server bundle, or null when encryption is not yet
   *  enrolled on this realm. */
  load(): ServerBundle | null;
  /** Persist the server bundle (overwrites — used only at first-boot
   *  enrollment + future recovery-key rotation; auto-unlock is
   *  read-only). */
  save(bundle: ServerBundle): void;
  /** Clear the stored bundle. Operator-side factory-reset only; never a
   *  remote client. */
  clear(): void;
  /** True when a server bundle is enrolled on this realm. Drives the
   *  KeyManager's startup state pick. */
  exists(): boolean;
}

export const createServerBundleStore = (
  db: Database.Database,
): ServerBundleStore => {
  // Idempotent — the bundle store + recovery-key store create the same
  // table; doing it here keeps this module independently constructable.
  db.exec(`CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  return {
    load() {
      const row = db.prepare(`SELECT value FROM server_config WHERE key = ?`).get(SERVER_BUNDLE_KEY) as
        | { value: string }
        | undefined;
      if (!row) return null;
      try {
        return serverBundleFromJSON(row.value);
      } catch {
        // Corrupt bundle — surface as "no bundle" so the server doesn't
        // hang on bad state. Operator must wipe + re-enrol.
        return null;
      }
    },

    save(bundle) {
      db.prepare(`INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`)
        .run(SERVER_BUNDLE_KEY, serverBundleToJSON(bundle));
    },

    clear() {
      db.prepare(`DELETE FROM server_config WHERE key = ?`).run(SERVER_BUNDLE_KEY);
    },

    exists() {
      const row = db.prepare(`SELECT 1 FROM server_config WHERE key = ?`).get(SERVER_BUNDLE_KEY);
      return row !== undefined;
    },
  };
};
