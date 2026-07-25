/** R26.4 Delta 2 (D-148 § A.9 P8) — durable passport export history.
 *
 *  `passport.export` writes the high-assurance `passport.exported` audit
 *  row (the INTENT ledger) AND appends here. This store is the
 *  denormalized, queryable cache the spec calls for (`passport/index.ts`
 *  `PassportHistoryStore` JSDoc): the audit detail is free-text and
 *  doesn't carry `exported_by_client_id` / `signer_fingerprint`, so the
 *  Settings → Backup & Recovery history list reads THIS store, not the
 *  ledger. Same SQLite db; durable across restarts (unlike the in-memory
 *  default used by tests).
 *
 *  Backed by `createSQLiteCollection` keyed on `passport_id` — exports
 *  are rare, deliberate user actions, so the in-memory sort/slice on
 *  `list()` is comfortably cheap (no index needed). */

import type Database from 'better-sqlite3';

import { createSQLiteCollection } from '../sqlite-collection.js';
import type { PassportHistoryEntry, PassportHistoryStore } from './index.js';

const TABLE = 'passport_history';

/** Ceiling for a single `list` page — clamps a caller-supplied `limit`
 *  so an absurd value can't force a full-table materialization into one
 *  rpc response. */
const MAX_HISTORY_PAGE = 200;
const DEFAULT_HISTORY_PAGE = 50;

export const createSqlitePassportHistoryStore = (
  db: Database.Database,
): PassportHistoryStore => {
  const collection = createSQLiteCollection<PassportHistoryEntry>(db, TABLE);
  return {
    async append(entry) {
      // Keyed on passport_id (unique per export) — append is an insert;
      // a re-append of the same id (shouldn't happen — ids are minted
      // per export) overwrites idempotently rather than duplicating.
      await collection.set(entry.passport_id, { ...entry });
    },
    async list(args) {
      const limit = Math.max(
        1,
        Math.min(args?.limit ?? DEFAULT_HISTORY_PAGE, MAX_HISTORY_PAGE),
      );
      const before = args?.before;
      const all = await collection.list();
      return all
        .filter((r) => before === undefined || r.exported_at < before)
        .sort((a, b) => b.exported_at - a.exported_at)
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
  };
};
