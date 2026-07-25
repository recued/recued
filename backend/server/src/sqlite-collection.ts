/** SQLite-backed Collection for the server's audit log.
 *
 *  Implements the Collection<V> interface from @recued/storage using
 *  a single JSON-blob table. Each entry is stored as a JSON string
 *  keyed by a primary key column. Simple, sufficient for audit logs
 *  and activities where the query patterns are append + list + delete.
 */

import type Database from 'better-sqlite3';
import type { Collection } from '@recued/storage';

/** Create a SQLite-backed Collection. Auto-creates the table. */
export const createSQLiteCollection = <V>(
  db: Database.Database,
  table: string,
): Collection<V> => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      key  TEXT NOT NULL PRIMARY KEY,
      data TEXT NOT NULL
    );
  `);

  return {
    async get(key) {
      const row = db.prepare(`SELECT data FROM ${table} WHERE key = ?`).get(key) as { data: string } | undefined;
      return row ? JSON.parse(row.data) as V : null;
    },

    async set(key, value) {
      db.prepare(`INSERT OR REPLACE INTO ${table} (key, data) VALUES (?, ?)`).run(key, JSON.stringify(value));
    },

    async delete(key) {
      db.prepare(`DELETE FROM ${table} WHERE key = ?`).run(key);
    },

    async has(key) {
      return !!db.prepare(`SELECT 1 FROM ${table} WHERE key = ?`).get(key);
    },

    async list() {
      const rows = db.prepare(`SELECT data FROM ${table}`).all() as { data: string }[];
      return rows.map(r => JSON.parse(r.data) as V);
    },

    async listKeys() {
      const rows = db.prepare(`SELECT key FROM ${table}`).all() as { key: string }[];
      return rows.map(r => r.key);
    },

    async listByPrefix(prefix) {
      const rows = db.prepare(`SELECT key, data FROM ${table} WHERE key LIKE ? || '%'`).all(prefix) as { key: string; data: string }[];
      return rows.map(r => ({ key: r.key, value: JSON.parse(r.data) as V }));
    },

    async deleteByPrefix(prefix) {
      const result = db.prepare(`DELETE FROM ${table} WHERE key LIKE ? || '%'`).run(prefix);
      return result.changes;
    },

    async clear() {
      db.prepare(`DELETE FROM ${table}`).run();
    },

    async size() {
      const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number };
      return row.cnt;
    },
  };
};
