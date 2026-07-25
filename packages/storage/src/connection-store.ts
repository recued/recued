/** D-125 Phase 1.2 — connection substrate IDB storage (extension).
 *
 *  Thin row store backed by `createIDBCollection<ConnectionRow>`.
 *  Composite primary key `${kind}:${name}` matches the spec § 1.5
 *  shape verbatim and aligns with the SQLite store's `(kind, name)`
 *  composite primary key on the server side. Both backends produce
 *  identical `ConnectionRow` shapes; the contracts-side
 *  `connectionViewFromRow` projects them to the resolver's
 *  `ConnectionView` (auth excluded by construction).
 *
 *  No rpc, no enrollment UX, no probe — those land in P2.x. P1.2
 *  ships the storage substrate that future phases layer on top of:
 *    - P2.1 wires `collection.connection.*` rpc handlers that read /
 *      write through this store on the ext side.
 *    - P2.2 wires the cloud sync delta scan via `listSince`.
 *    - P3.1 swaps the kernel adapter into D-126's reserved registry
 *      slot; the adapter reads `auth_ciphertext` from rows (decrypts
 *      via the connection sub-DEK) and never surfaces it to the
 *      `ConnectionView`. */

import type { ConnectionKind, ConnectionRow } from '@recued/contracts';
import { connectionRowKey } from '@recued/contracts';
import { createIDBCollection, type IDBCollection } from './idb-collection.js';

const DEFAULT_DB_NAME = 'recued-connections';

export interface ConnectionRowStore {
  /** Upsert by composite key. Fully replaces the row when present.
   *  LWW semantics live one layer up at the sync wire (P2.2); this
   *  store always honors the caller's `updated_at`. */
  upsert(row: ConnectionRow): Promise<void>;
  /** Fetch by composite key or null when absent. */
  get(kind: ConnectionKind, name: string): Promise<ConnectionRow | null>;
  /** List every row, optionally filtered by kind. Newest `updated_at`
   *  first — drives the Settings → Connections list and the sync
   *  delta scan. */
  list(query?: { kind?: ConnectionKind }): Promise<ConnectionRow[]>;
  /** List rows with `updated_at > since` for sync delta scans
   *  (P2.2 cloud sync wire). Newest first. */
  listSince(since: number): Promise<ConnectionRow[]>;
  /** Delete by composite key. Returns true when a row was removed. */
  delete(kind: ConnectionKind, name: string): Promise<boolean>;
  /** Total row count — Settings page header. */
  count(): Promise<number>;
  /** Wipe every row. Used on sign-out / clear-data flows. */
  clear(): Promise<void>;
}

export interface ConnectionRowStoreOptions {
  /** IndexedDB database name. Defaults to `recued-connections`. Tests
   *  override per-suite to keep stores isolated. */
  dbName?: string;
  /** Override the backing collection. Tests pass an in-memory double. */
  collection?: IDBCollection<ConnectionRow>;
}

/** Build an IDB-backed connection-row store. The underlying
 *  `createIDBCollection` walks the store with a cursor for `list*`
 *  operations — fine for the modest sizes expected (a single user's
 *  enrolled connections, typically < 100 rows). */
export const createConnectionRowStore = (
  options: ConnectionRowStoreOptions = {},
): ConnectionRowStore => {
  const collection = options.collection
    ?? createIDBCollection<ConnectionRow>({
      dbName: options.dbName ?? DEFAULT_DB_NAME,
    });

  const sortByUpdatedAtDesc = (rows: ConnectionRow[]): ConnectionRow[] =>
    rows.slice().sort((a, b) => {
      if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at;
      return a.name.localeCompare(b.name);
    });

  return {
    async upsert(row) {
      // Force-stamp the composite key so callers can't accidentally
      // store a row under a key that doesn't match its (kind, name).
      // The IDB collection uses out-of-line keys, so a mismatch would
      // surface as a stale row that no get(kind, name) lookup ever
      // finds — silent corruption.
      const pk = connectionRowKey(row.kind, row.name);
      await collection.set(pk, { ...row, pk });
    },

    async get(kind, name) {
      return collection.get(connectionRowKey(kind, name));
    },

    async list(query = {}) {
      const all = await collection.list();
      const filtered = query.kind
        ? all.filter((r) => r.kind === query.kind)
        : all;
      return sortByUpdatedAtDesc(filtered);
    },

    async listSince(since) {
      const all = await collection.list();
      return sortByUpdatedAtDesc(all.filter((r) => r.updated_at > since));
    },

    async delete(kind, name) {
      const pk = connectionRowKey(kind, name);
      const existed = await collection.has(pk);
      if (!existed) return false;
      await collection.delete(pk);
      return true;
    },

    async count() {
      return collection.size();
    },

    async clear() {
      await collection.clear();
    },
  };
};
