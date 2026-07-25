/** R27 delta-B — DDNS publish enable/pause flag (server-local).
 *
 *  The user's own choice to publish (`enabled: true`) or pause
 *  (`enabled: false`) their Pro DDNS hostname. Independent of the Pro
 *  SUBSCRIPTION (Paddle) — pausing only stops `<handle>.<zone>` from
 *  resolving to this server; billing is untouched.
 *
 *  Two jobs:
 *    1. Gates the DDNS update poller (`wire-ddns-update-poller.ts`) — a
 *       paused server stops REFRESHING its record.
 *    2. The `ddns.setEnabled` handler flips it (after the cloud
 *       `/v1/ddns/pause` verb actually pulls/restores the record).
 *
 *  Singleton row keyed on `'ddns_enabled'` inside the existing
 *  `server_config` table (same table the DDNS IP state uses). No new
 *  schema. **DEFAULT-ENABLED when absent** — a fresh server publishes
 *  normally; only an explicit pause writes `false` (mirrors the
 *  auto-run-scheduler "absent row = enabled" convention). */

import type Database from 'better-sqlite3';

export interface DdnsEnabledStore {
  /** `true` = DDNS publishing (default when no row exists); `false` =
   *  the user paused publication. */
  isEnabled(): boolean;
  /** Persist the user's publish/pause choice. */
  setEnabled(enabled: boolean): void;
}

const ROW_KEY = 'ddns_enabled';

export const createSqliteDdnsEnabledStore = (
  db: Database.Database,
): DdnsEnabledStore => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );

  const readStmt = db.prepare(`SELECT value FROM server_config WHERE key = ?`);
  const writeStmt = db.prepare(
    `INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`,
  );

  return {
    isEnabled(): boolean {
      const row = readStmt.get(ROW_KEY) as { value: string } | undefined;
      if (!row) return true; // absent → enabled (default-publish)
      try {
        const parsed = JSON.parse(row.value) as { enabled?: unknown };
        // Only an explicit stored `false` pauses; anything else
        // (corrupt / unexpected shape) fails OPEN to enabled — a
        // server should keep publishing rather than silently go dark.
        return parsed.enabled !== false;
      } catch {
        return true;
      }
    },

    setEnabled(enabled: boolean): void {
      writeStmt.run(ROW_KEY, JSON.stringify({ enabled }));
    },
  };
};

/** In-memory store for tests. Default-enabled unless `initial` says otherwise. */
export const createInMemoryDdnsEnabledStore = (
  initial = true,
): DdnsEnabledStore => {
  let enabled = initial;
  return {
    isEnabled: () => enabled,
    setEnabled: (next) => {
      enabled = next;
    },
  };
};
