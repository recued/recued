/** SQLite-backed Collection for the server's audit log.
 *
 *  Implements the Collection<V> interface from @recued/storage using
 *  a single JSON-blob table. Each entry is stored as a JSON string
 *  keyed by a primary key column. Simple, sufficient for audit logs
 *  and activities where the query patterns are append + list + delete.
 */

import type Database from 'better-sqlite3';
import { prefixUpperBound } from './storage/prefix-range.js';
import type {
  Collection,
  FieldQuery,
  FieldQueryableCollection,
} from '@recued/storage';

/** ⛔ FIELD NAMES ARE INTERPOLATED INTO SQL, so they are validated rather than
 *  parameterised — a JSON path cannot be a bind parameter in `json_extract`.
 *  Callers are first-party stores naming their own fields, but "first-party"
 *  is not a security property, and a field name that reached here from a
 *  recipe or an rpc payload would be an injection point. Conservative by
 *  construction: identifier characters only. */
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const assertField = (field: string): string => {
  if (!FIELD_RE.test(field)) {
    throw new Error(
      `sqlite-collection: invalid field name "${field}" — top-level `
      + 'identifier characters only',
    );
  }
  return field;
};

/** Build the WHERE fragment + bind params for a `FieldQuery`. An EMPTY query
 *  yields `1=1`, which matches everything — correct for `query`/`count` and
 *  catastrophic for `delete`, so `deleteByField` refuses it explicitly. */
const buildWhere = (spec: FieldQuery): { sql: string; params: unknown[] } => {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const [field, value] of Object.entries(spec.equals ?? {})) {
    clauses.push(`json_extract(data, '$.${assertField(field)}') = ?`);
    params.push(value);
  }
  if (spec.lessThan) {
    clauses.push(`json_extract(data, '$.${assertField(spec.lessThan.field)}') < ?`);
    params.push(spec.lessThan.value);
  }
  return {
    sql: clauses.length > 0 ? clauses.join(' AND ') : '1=1',
    params,
  };
};

/** Create a SQLite-backed Collection. Auto-creates the table.
 *
 *  Returns the `FieldQueryableCollection` widening — see that interface for
 *  why it exists. Consumers still feature-detect with `isFieldQueryable`,
 *  because the in-memory and IndexedDB backings do not implement it. */
export const createSQLiteCollection = <V>(
  db: Database.Database,
  table: string,
): FieldQueryableCollection<V> => {
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

    // ⛔ RANGE, not `LIKE ? || '%'` — see `prefix-range.ts`. `LIKE` with a
    // bound pattern cannot use the index (SCAN, O(total keys)) AND treats `_`
    // / `%` in the caller's prefix as wildcards, which on `deleteByPrefix`
    // means deleting rows the caller never named. A `null` bound means the
    // prefix matches everything, which is the whole table.
    async listByPrefix(prefix) {
      const upper = prefixUpperBound(prefix);
      const rows = (upper === null
        ? db.prepare(`SELECT key, data FROM ${table}`).all()
        : db
          .prepare(`SELECT key, data FROM ${table} WHERE key >= ? AND key < ?`)
          .all(prefix, upper)) as { key: string; data: string }[];
      return rows.map(r => ({ key: r.key, value: JSON.parse(r.data) as V }));
    },

    async deleteByPrefix(prefix) {
      const upper = prefixUpperBound(prefix);
      const result = upper === null
        ? db.prepare(`DELETE FROM ${table}`).run()
        : db
          .prepare(`DELETE FROM ${table} WHERE key >= ? AND key < ?`)
          .run(prefix, upper);
      return result.changes;
    },

    async clear() {
      db.prepare(`DELETE FROM ${table}`).run();
    },

    async size() {
      const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number };
      return row.cnt;
    },

    async queryByField(spec) {
      const { sql, params } = buildWhere(spec);
      const rows = db
        .prepare(`SELECT data FROM ${table} WHERE ${sql}`)
        .all(...params) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data) as V);
    },

    async countByField(spec) {
      const { sql, params } = buildWhere(spec);
      // COUNT(*), so no row is materialised and nothing is JSON-parsed — the
      // whole point of the capability.
      const row = db
        .prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE ${sql}`)
        .get(...params) as { cnt: number };
      return row.cnt;
    },

    async deleteByField(spec) {
      // ⛔ AN EMPTY QUERY WOULD DELETE THE TABLE. `buildWhere` renders `1=1`
      // for a spec with no predicates, which is the right answer for a read
      // and a catastrophe for a delete. A caller that builds its spec
      // dynamically and produces an empty one gets an error, not a wipe.
      if (
        Object.keys(spec.equals ?? {}).length === 0
        && spec.lessThan === undefined
      ) {
        throw new Error(
          'sqlite-collection.deleteByField: refusing an empty query — it would '
          + 'delete every row. Use clear() if that is genuinely intended.',
        );
      }
      const { sql, params } = buildWhere(spec);
      return db.prepare(`DELETE FROM ${table} WHERE ${sql}`).run(...params).changes;
    },

    ensureFieldIndexes(fields) {
      for (const field of fields) {
        assertField(field);
        // Expression index over the SAME `json_extract(data, '$.<field>')`
        // text the queries emit — SQLite matches expression indexes
        // syntactically, so any divergence here silently degrades every query
        // above back to a full scan while still returning correct answers.
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_${table}_${field} `
          + `ON ${table} (json_extract(data, '$.${field}'))`,
        );
      }
    },
  };
};
