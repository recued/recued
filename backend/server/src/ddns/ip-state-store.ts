/** D-148 § A.14 — DDNS IP state persistence.
 *
 *  Stores the last successfully-published IP (+ the timestamp the
 *  cloud confirmed it) so a daemon restart doesn't re-POST a no-change
 *  update on the first tick. The cloud also dedupes internally, but
 *  doing it locally too saves a network call + a rate-limit token.
 *
 *  Singleton row keyed on `'ddns_ip_state'` inside the existing
 *  `server_config` table (same table the realm token uses). No new
 *  schema; one INSERT OR REPLACE per successful update.
 *
 *  Shape:
 *    {
 *      ip_v4: string,
 *      ip_v6?: string,
 *      last_published_at: number  // unix-ms cloud-confirmed
 *    }
 *
 *  `load()` returns `null` when no row exists (first boot, or before
 *  the first successful update). */

import type Database from 'better-sqlite3';

export interface DdnsIpStateSnapshot {
  ip_v4: string;
  ip_v6?: string;
  last_published_at: number;
  published_targets?: ReadonlyArray<DdnsPublishedTargetSnapshot>;
}

export interface DdnsPublishedTargetSnapshot {
  publisher_id: string;
  handle: string;
}

export interface DdnsIpStateStore {
  load(): DdnsIpStateSnapshot | null;
  save(snapshot: DdnsIpStateSnapshot): void;
}

const ROW_KEY = 'ddns_ip_state';

const cloneSnapshot = (snapshot: DdnsIpStateSnapshot): DdnsIpStateSnapshot => {
  const out: DdnsIpStateSnapshot = {
    ip_v4: snapshot.ip_v4,
    last_published_at: snapshot.last_published_at,
  };
  if (snapshot.ip_v6 !== undefined) out.ip_v6 = snapshot.ip_v6;
  if (snapshot.published_targets !== undefined) {
    out.published_targets = snapshot.published_targets.map((target) => ({
      publisher_id: target.publisher_id,
      handle: target.handle,
    }));
  }
  return out;
};

const isValidSnapshot = (value: unknown): value is DdnsIpStateSnapshot => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ip_v4 === 'string' &&
    v.ip_v4.length > 0 &&
    typeof v.last_published_at === 'number' &&
    Number.isFinite(v.last_published_at) &&
    (v.ip_v6 === undefined || typeof v.ip_v6 === 'string') &&
    (
      v.published_targets === undefined ||
      (
        Array.isArray(v.published_targets) &&
        v.published_targets.every((target) => {
          if (!target || typeof target !== 'object') return false;
          const t = target as Record<string, unknown>;
          return typeof t.publisher_id === 'string' &&
            t.publisher_id.length > 0 &&
            typeof t.handle === 'string' &&
            t.handle.length > 0;
        })
      )
    )
  );
};

export const createSqliteDdnsIpStateStore = (
  db: Database.Database,
): DdnsIpStateStore => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );

  const readStmt = db.prepare(
    `SELECT value FROM server_config WHERE key = ?`,
  );
  const writeStmt = db.prepare(
    `INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)`,
  );

  return {
    load(): DdnsIpStateSnapshot | null {
      const row = readStmt.get(ROW_KEY) as { value: string } | undefined;
      if (!row) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        // Corrupt JSON — return null so the poller treats this as
        // "first publish" and a successful POST overwrites the row.
        return null;
      }
      if (!isValidSnapshot(parsed)) return null;
      // Construct the snapshot explicitly so `exactOptionalPropertyTypes`
      // doesn't complain about `ip_v6: undefined` (TS treats an
      // explicit-undefined key as a different shape than an absent key).
      return cloneSnapshot(parsed);
    },

    save(snapshot: DdnsIpStateSnapshot): void {
      writeStmt.run(ROW_KEY, JSON.stringify(snapshot));
    },
  };
};

/** In-memory store for tests. */
export const createInMemoryDdnsIpStateStore = (
  initial?: DdnsIpStateSnapshot,
): DdnsIpStateStore => {
  let snapshot: DdnsIpStateSnapshot | null = initial ? cloneSnapshot(initial) : null;
  return {
    load() {
      return snapshot ? cloneSnapshot(snapshot) : null;
    },
    save(next) {
      snapshot = cloneSnapshot(next);
    },
  };
};
