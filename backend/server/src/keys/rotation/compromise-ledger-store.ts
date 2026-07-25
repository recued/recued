/** R26.4 Delta 3 (D-148 § A.11) — durable compromise ledger.
 *
 *  The `RotationEngine`'s `markCompromised` flow records that a key
 *  class has been flagged compromised; the Key Health page reads the
 *  flag back as a per-class `compromise_alert` banner. The engine module
 *  ships an in-memory ledger (`createInMemoryCompromiseLedger`) for tests
 *  + dbless harnesses, and its docstring always intended production to
 *  "wire through SQLite via the D-148 P5 `server_state` table." This is
 *  that durable backing.
 *
 *  Durability matters precisely for the one case the in-memory ledger
 *  drops: a class that is marked compromised but CANNOT auto-rotate on
 *  this realm (e.g. `master_dek` on self-host, where the rotation hooks
 *  are dormant → the cascade returns `key_not_loaded` → the flag stays
 *  set). The operator needs that alert to survive a restart until they
 *  resolve it manually. A successful rotation clears the flag (the dirty
 *  material is gone from the active path), so the table normally holds
 *  zero rows.
 *
 *  Backed by `createSQLiteCollection` (auto-creates the table, no
 *  migration) keyed on the `KeyClass` string. Mirrors the
 *  `CompromiseLedger` interface from `./index.js` verbatim so it drops
 *  into `createRotationEngine({ compromise_ledger })` interchangeably
 *  with the in-memory variant. */

import type Database from 'better-sqlite3';
import type { KeyClass } from '@recued/contracts';

import { createSQLiteCollection } from '../../sqlite-collection.js';
import type { CompromiseLedger } from './index.js';

/** One row per compromised key class. Carries provenance so the audit
 *  surface + a future Key Health "marked by / when / why" detail can
 *  read it without a separate audit-log join. */
interface CompromiseRecord {
  key_class: KeyClass;
  marked_at: number;
  triggered_by_client_id: string;
  reason?: string;
}

/** Create a SQLite-backed compromise ledger over `key_compromise_ledger`.
 *  Keyed on `key_class` so `mark` is idempotent at the storage layer
 *  (a second mark overwrites the row) — the engine's own `isMarked`
 *  pre-check is what makes a re-mark surface `compromise_already_recorded`
 *  rather than silently re-cascading. */
export const createSqliteCompromiseLedger = (
  db: Database.Database,
): CompromiseLedger => {
  const col = createSQLiteCollection<CompromiseRecord>(db, 'key_compromise_ledger');
  return {
    async isMarked(key_class) {
      return col.has(key_class);
    },
    async mark({ key_class, marked_at, triggered_by_client_id, reason }) {
      await col.set(key_class, {
        key_class,
        marked_at,
        triggered_by_client_id,
        ...(reason !== undefined ? { reason } : {}),
      });
    },
    async clear(key_class) {
      await col.delete(key_class);
    },
  };
};
