/** Bundle persistence — wraps the existing `server_config` SQLite table.
 *
 *  Bundles are ~200-byte JSON blobs stored under key 'bundle'. Keeping
 *  them in server_config means one SQLite file holds everything the
 *  server needs to resume state (realm token, instance id, bundle).
 *  No separate files to sync, back up, or lose.
 *
 *  This module does not do any crypto — it's pure I/O. Validation lives
 *  in @recued/crypto's bundleFromJSON; we delegate to it on read.
 */

import type Database from 'better-sqlite3';
import { bundleToJSON, bundleFromJSON, type Bundle } from '@recued/crypto';

const BUNDLE_KEY = 'bundle';

export interface BundleStore {
  load(): Bundle | null;
  save(bundle: Bundle): void;
  clear(): void;
  /** True when a bundle is persisted. Used by KeyManager to pick the
   *  startup state. */
  exists(): boolean;
}

/** Create a bundle store backed by the server_config table. The caller
 *  is responsible for ensuring the table exists (bin.ts creates it). */
export const createBundleStore = (db: Database.Database): BundleStore => {
  db.exec(`CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  return {
    load() {
      const row = db.prepare(`SELECT value FROM server_config WHERE key = ?`).get(BUNDLE_KEY) as
        | { value: string }
        | undefined;
      if (!row) return null;
      try {
        return bundleFromJSON(row.value);
      } catch {
        // Corrupt bundle — surface as "no bundle" so we don't hang the
        // server on bad state. Operator must wipe and re-init.
        return null;
      }
    },

    save(bundle) {
      const json = bundleToJSON(bundle);
      db.prepare(`INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`)
        .run(BUNDLE_KEY, json);
    },

    clear() {
      db.prepare(`DELETE FROM server_config WHERE key = ?`).run(BUNDLE_KEY);
    },

    exists() {
      const row = db.prepare(`SELECT 1 FROM server_config WHERE key = ?`).get(BUNDLE_KEY);
      return row !== undefined;
    },
  };
};
